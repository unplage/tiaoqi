import glob
import json
import os
import sys
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL_PATH = "/games/sanguo/"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def launch_browser(pw):
    try:
        return pw.chromium.launch(headless=True, args=["--no-sandbox"])
    except Exception:
        pass
    cache = Path.home() / ".cache" / "ms-playwright"
    candidates = sorted(
        glob.glob(str(cache / "chromium-*" / "chrome-linux64" / "chrome")),
        reverse=True,
    )
    for exe in candidates:
        try:
            return pw.chromium.launch(
                headless=True, executable_path=exe, args=["--no-sandbox"]
            )
        except Exception:
            continue
    raise RuntimeError("未找到可用的 Chromium，请先运行 playwright install chromium")


def main():
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT))
    )
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}{URL_PATH}"
    shots = Path(tempfile.mkdtemp(prefix="sanguo-verify-"))
    errors = []
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)
            print("FAIL:", msg)
        else:
            print("ok:", msg)

    with sync_playwright() as pw:
        browser = launch_browser(pw)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        page.on(
            "console",
            lambda m: errors.append("console: " + m.text) if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))

        page.goto(url, wait_until="load")
        page.wait_for_function("window.__SANGUO__ && window.__SANGUO__.state")
        check(page.evaluate("__SANGUO__.state") == "menu", "进入主菜单")
        page.screenshot(path=str(shots / "menu.png"))

        page.evaluate("__SANGUO__.startAt(1,1)")
        page.wait_for_timeout(200)
        check(page.evaluate("__SANGUO__.state") == "playing", "开始第 1 关")
        check(page.evaluate("__SANGUO__.player.hp") > 0, "玩家初始生命有效")

        page.evaluate("__SANGUO__.spawn('shield')")
        page.evaluate("__SANGUO__.spawn('archer')")
        page.evaluate("__SANGUO__.spawn('cavalry', true)")
        page.evaluate("__SANGUO__.giveGold(200)")
        page.evaluate("__SANGUO__.attack(); __SANGUO__.tick(40)")
        page.evaluate("__SANGUO__.skill(); __SANGUO__.tick(40)")
        page.evaluate("__SANGUO__.dodge(); __SANGUO__.tick(20)")
        page.evaluate("__SANGUO__.summon(); __SANGUO__.tick(30)")
        page.evaluate("__SANGUO__.fillFin(); __SANGUO__.fin(); __SANGUO__.tick(60)")
        combat = page.evaluate(
            "({kills:__SANGUO__.game.perf.kills,score:__SANGUO__.game.score,"
            "troops:__SANGUO__.troops.length,fin:__SANGUO__.game.finMeter})"
        )
        check(combat["kills"] > 0, "战斗造成击杀: " + str(combat["kills"]))
        check(isinstance(combat["score"], (int, float)), "得分数值有效")
        check(combat["troops"] > 0, "召兵成功")

        w0 = page.evaluate("__SANGUO__.player.weapon")
        page.keyboard.press("q")
        w1 = page.evaluate("__SANGUO__.player.weapon")
        check(w0 != w1, "Q/E 切换武器")
        t0 = page.evaluate("__SANGUO__.game.troopType")
        page.keyboard.press("3")
        t1 = page.evaluate("__SANGUO__.game.troopType")
        check(t0 != t1, "数字键切换兵种")
        page.evaluate("__SANGUO__.tick(100)")
        page.keyboard.down("i")
        page.evaluate("__SANGUO__.tick(3)")
        check(page.evaluate("__SANGUO__.player.block") is True, "按住 I 进入格挡")
        page.keyboard.up("i")
        page.evaluate("__SANGUO__.tick(3)")

        page.keyboard.press("p")
        check(page.evaluate("__SANGUO__.state") == "paused", "P 暂停")
        page.screenshot(path=str(shots / "pause.png"))
        page.keyboard.press("p")
        check(page.evaluate("__SANGUO__.state") == "playing", "P 继续")

        page.evaluate("__SANGUO__.forceGate()")
        page.evaluate("__SANGUO__.tick(200)")
        check(page.evaluate("!!__SANGUO__.boss"), "击破城门后出现 BOSS")
        page.evaluate("__SANGUO__.boss.hp=__SANGUO__.boss.maxHp*0.4")
        page.evaluate("__SANGUO__.tick(5)")
        check(page.evaluate("__SANGUO__.boss.phase") == 2, "BOSS 半血进入狂暴")
        page.evaluate("__SANGUO__.killBoss()")
        page.evaluate("__SANGUO__.tick(5)")
        check(page.evaluate("__SANGUO__.state") == "shop", "击败 BOSS 进入商店")
        check(page.evaluate("__SANGUO__.save.unlocked") >= 2, "解锁下一关并存档")
        page.screenshot(path=str(shots / "shop.png"))

        lv0 = page.evaluate("__SANGUO__.save.up.skill")
        page.keyboard.press("1")
        lv1 = page.evaluate("__SANGUO__.save.up.skill")
        check(lv1 == lv0 + 1, "商店升级技能并写入存档")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        check(
            page.evaluate("__SANGUO__.state") == "playing"
            and page.evaluate("__SANGUO__.game.level") == 2,
            "商店进入下一关",
        )
        page.screenshot(path=str(shots / "play.png"))

        page.reload(wait_until="load")
        page.wait_for_function("window.__SANGUO__")
        check(page.evaluate("__SANGUO__.save.unlocked") >= 2, "刷新后保留解锁进度")
        check(page.evaluate("__SANGUO__.save.up.skill") == lv1, "刷新后保留升级")
        browser.close()

        mobile = launch_browser(pw)
        mctx = mobile.new_context(
            viewport={"width": 844, "height": 390}, has_touch=True, is_mobile=True
        )
        mpage = mctx.new_page()
        mpage.on("pageerror", lambda e: errors.append("mobile pageerror: " + str(e)))
        mpage.goto(url, wait_until="load")
        mpage.wait_for_function("window.__SANGUO__")
        check(
            mpage.evaluate("getComputedStyle(document.getElementById('touch')).display")
            == "flex",
            "触屏设备显示虚拟按键",
        )
        mpage.evaluate("__SANGUO__.startAt(1,1)")
        mpage.wait_for_timeout(150)
        for btn in ("bAtk", "bSkill", "bDodge", "bTroop", "bNext", "bWeapon", "bPause"):
            mpage.locator("#" + btn).tap()
            mpage.wait_for_timeout(50)
        check(mpage.evaluate("__SANGUO__.state") == "paused", "触屏暂停按钮生效")
        mpage.locator("#bPause").tap()
        mpage.wait_for_timeout(100)
        check(mpage.evaluate("__SANGUO__.state") == "playing", "触屏恢复战斗")
        mpage.screenshot(path=str(shots / "mobile.png"))
        mobile.close()

    server.shutdown()
    print("截图目录:", shots)
    if errors:
        print("页面错误:")
        print(json.dumps(errors, ensure_ascii=False, indent=2))
    if failures or errors:
        print("验证失败")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
