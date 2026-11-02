import { setStyleSheet, TileSetManager } from "../utils.js";

function fileLoader(evt) {
  return new Promise((resolve, reject) => {
    const file = evt.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        file.dataURL = e.target.result;
        if (file.size > 500000) {
          alert("图片不能超过500KB");
          return reject();
        }
        resolve(file);
      };
      reader.readAsDataURL(file);
    } else reject();
  });
}

class ThemeModal {
  constructor(modal) {
    this.modal = modal;
    this.init();
  }

  init() {
    this.loadBackground();
    this.loadSidebar();
    this.loadPlayerBanks();
    this.load牌背/牌面();
  }

  reset() {
    [
      `mahjongBackground`,
      `mahjongSidebar`,
      `mahjongPlayerBanks`,
      `mahjong牌背/牌面`,
      `mahjongCSS`,
    ].forEach((key) => {
      localStorage.removeItem(key);
      const e = document.getElementById(`mahjongBackground`);
      if (e) {
        e.parentNode.removeChild(e);
      }
    });
    globalThis.location.reload();
  }

  loadBackground() {
    const dataURL = localStorage.getItem("mahjongBackground");
    if (dataURL) {
      setStyleSheet(
        `mahjongBackground`,
        `.board .discards { background-image: url(${dataURL}); }`
      );
    }
    return !!dataURL;
  }

  saveBackground(background) {
    localStorage.setItem("mahjongBackground", background);
  }

  loadSidebar() {
    const dataURL = localStorage.getItem("mahjongSidebar");
    if (dataURL) {
      setStyleSheet(
        `mahjongSidebar`,
        `.board .sidebar { background-image: url(${dataURL}); }`
      );
    }
    return !!dataURL;
  }

  saveSidebar(background) {
    localStorage.setItem("mahjongSidebar", background);
  }

  loadPlayerBanks() {
    const dataURL = localStorage.getItem("mahjongPlayerBanks");
    if (dataURL) {
      setStyleSheet(
        `mahjongPlayerBanks`,
        `.players .player { background-image: url(${dataURL}); }`
      );
    }
    return !!dataURL;
  }

  savePlayerBanks(background) {
    localStorage.setItem("mahjongPlayerBanks", background);
  }

  async load牌背/牌面() {
    const dataURL = localStorage.getItem("mahjong牌背/牌面");
    if (dataURL) {
      setStyleSheet(
        `mahjong牌背/牌面`,
        await TileSetManager.createTileSetCSS(dataURL)
      );
    } else { TileSetManager.loadDefault(); }
    return !!dataURL;
  }

  save牌背/牌面(background) {
    localStorage.setItem("mahjong牌背/牌面", background);
  }

  /**
   * Configure all the configurable options and
   * then relaunch the game on the appropriate URL.
   */
  show() {
    const panel = this.modal.makePanel(`settings`);
    panel.innerHTML = `<h3>Change the game theme</h3>`;
    const options = this.getOptions();
    const table = this.modal.buildPanelContent(options);
    this.addFormControls(panel, table, options);
    this.modal.addFooter(panel, "Close");
  }

  addFormControls(panel, table, options) {
    let row = document.createElement(`tr`);
    row.classList.add(`spacer-1`);
    row.innerHTML = `
      <td colspan="2">
        <input id="reset" type="reset" value="恢复默认设置">
      </td>
    `;
    table.appendChild(row);

    let reset = table.querySelector(`#reset`);
    reset.addEventListener("click", () => this.reset());
  }

  getOptions() {
    const handle = (fnName) => (entry, evt) =>
      fileLoader(evt).then((file) => {
        this[`save${fnName}`](file.dataURL);
        this[`load${fnName}`]();
      });

    const options = [
      {
        label: "背景图片",
        type: `file`,
        handler: handle("Background"),
      },
      {
        label: "侧边图片",
        type: `file`,
        handler: handle("Sidebar"),
      },
      {
        label: "玩家面板图片",
        type: `file`,
        handler: handle("PlayerBanks"),
      },
      {
        label: "牌背/牌面",
        type: `file`,
        handler: handle("牌背/牌面"),
      },
      {
        label: "颜色方案",
        button_label: "更改...",
        type: `button`,
        evtType: `click`,
        handler: (entry, evt) => {
          this.modal.pickColors();
        }
      }
    ];

    return options;
  }
}

export { ThemeModal };
