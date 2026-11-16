"use strict";
document.getElementById("open-settings").addEventListener("click", () => {
  window.webkit.messageHandlers.controller.postMessage("open-preferences");
});
