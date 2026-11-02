import "../core/utils/utils.js";
import { config } from "../../config.js";
import { modal } from "../page/modal/modal.js";
import { GameManager } from "../core/game/game-manager.js";
import { rotateWinds } from "../core/players/ui/windicator.js";

// import { ClientUIMaster } from "../core/players/ui/client-ui-master.js";

/**
 * This is the function that runs as the very first call
 * when the web page loads: do you want to play a game,
 * or do you want to watch the bots play each other?
 */
(function () {
  // functions are always "hoisted" to above any
  // actual code, so the following lines work,
  // despite the functions being declared "later".
  if (config.PLAY_IMMEDIATELY) play();
  else offerChoice();

  // Forced bot play
  function play() {
    let manager = new GameManager();
    let game = manager.newGame();
    game.startGame(() => {
      document.body.classList.add("finished");
      let gameui = game.players.find((p) => p.ui).ui;
      config.flushLog();
      return modal.showFinalScores(
        gameui,
        game.rules,
        game.scoreHistory,
        () => {
          document.body.classList.remove("finished");
          rotateWinds.reset();
          offerChoice();
        }
      );
    });
  }

  // Optional bot play.
  function offerChoice() {
    const options = [
      { description: "当前有以下两种对局方式：" },
      { label: "我想亲自玩麻将", value: "play" },
      { label: "我只想看电脑对局", value: "watch" },
      {
        description: "Alternatively, you can modify the game settings:",
        align: "center",
      },
      { label: "更改设置", value: "settings", back: true },
      { label: "更改主题", value: "theming", back: true },
      {
        description: "(you can also open the settings during play)",
        align: "center",
      },
    ];
    options.fixed = true;
    modal.choiceInput(
      "欢迎来到麻将桌，你想做什么？",
      options,
      (result) => {
        config.BOT_PLAY = result === "watch";
        if (result === "watch") config.FORCE_OPEN_BOT_PLAY = true;
        if (result === "settings") return modal.pickPlaySettings();
        if (result === "theming") return modal.pickTheming();
        play();
      }
    );
  }
})();
