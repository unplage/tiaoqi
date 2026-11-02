import { config } from "../../../config.js";
import { Ruleset } from "../../core/scoring/ruleset.js";
import { WallHack  } from "../../core/game/wall/wall-hack.js";

class SettingsModal {
  constructor(modal) {
    this.modal = modal;
  }

  show() {
    let panel = this.modal.makePanel(`settings`);
    panel.innerHTML = `
      <h3>Change the game settings</h3>
      <p>
        The follow settings change how the game works, but while
        the first three options are related to playing the game,
        all the other options are primarily intended for debugging.
      </p>
    `;
    const options = this.getOptions();
    const form = this.modal.buildPanelContent(options, true);
    form.setAttribute("name", "settings");
    form.setAttribute("action", "index.html");
    form.setAttribute("method", "GET");
    this.addFormControls(panel, form, options);
    this.modal.addFooter(panel, "不保存并关闭");
  }

  addFormControls(panel, form, options) {
    const table = form.querySelector(`table`);
    let row = document.createElement(`tr`);
    row.classList.add(`spacer-1`);
    row.innerHTML = `
      <td>
        <input id="reset" type="reset" value="恢复默认设置">
      </td>
      <td>
        <input id="ok" type="submit" value="使用这些设置开始">
      </td>
    `;
    table.appendChild(row);

    form.addEventListener(`submit`, (evt) => {
      evt.preventDefault();
      let suffix = options
        .filter((e) => e.value != e.default_value)
        .map((e) => `${e.key}=${e.value}`)
        .join("&");
        globalThis.location.search = suffix ? `?${suffix}` : ``;
    });

    let ok = table.querySelector(`#ok`);
    panel.gainFocus = () => ok.focus();

    let reset = table.querySelector(`#reset`);
    reset.addEventListener("click", (evt) => (globalThis.location.search = ""));
  }

  getOptions() {
    const options = [
      {
        label: `规则`,
        key: `rules`,
        options: [...Ruleset.getRulesetNames()],
      },
      {
        // basic boolean flags:
      },
      {
        label: `🀄 对所有玩家明牌`,
        key: `force_open_bot_play`,
        toggle: true,
      },
      {
        label: `✨ 高亮可claim的弃牌`,
        key: `show_claim_suggestion`,
        toggle: true,
      },
      {
        label: `💬 显示AI建议`,
        key: `show_bot_suggestion`,
        toggle: true,
      },
      {
        // additional boolean flags:
      },
      {
        label: `🎵 音效`,
        key: `use_sound`,
        toggle: true,
      },
      {
        label: `🟢 载入后立即开始`,
        key: `play_immediately`,
        toggle: true,
      },
      {
        label: `⏸️ 失去焦点时暂停`,
        key: `pause_on_blur`,
        toggle: true,
      },
      {
        label: `💻 开启调试模式`,
        key: `debug`,
        toggle: true,
      },
      {
        label: `❌ 模拟上局流局`,
        key: `force_draw`,
        toggle: true,
        debug_only: true,
      },
      {
        label: `📃 生成对局日志`,
        key: `write_game_log`,
        toggle: true,
        debug_only: true,
      },
      {
        // numerical values:
      },
      {
        label: `设置PRNG种子`,
        key: `seed`,
        debug_only: true,
      },
      {
        label: `AI胡牌阈值`,
        key: `bot_chicken_threshold`,
        debug_only: true,
      },
      {
        label: `每步出牌间隔(ms)`,
        key: `play_interval`,
      },
      {
        label: `下局开始间隔(ms)`,
        key: `hand_interval`,
      },
      {
        label: `AI反应间隔(ms)`,
        key: `bot_delay_before_discard_ends`,
      },
      {
        label: `AI演示出牌间隔(ms)`,
        key: `bot_play_delay`,
      },
      // and debug hacking
      {
        label: `指定牌墙布局`,
        key: `wall_hack`,
        options: [``, ...Object.keys(WallHack.hacks)],
        debug_only: true,
      },
    ];

    options.forEach((entry) => {
      const { key } = entry;
      if (key) {
        const CONFIG_KEY = key.toUpperCase();
        entry.value = config[CONFIG_KEY];
        entry.default_value = config.DEFAULT_CONFIG[CONFIG_KEY];
      }
    });
    return options;
  }
}

export { SettingsModal };
