import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/katex.css";
import "./styles/writing.css";

import { el } from "./lib/dom";
import { notify } from "./ui/toast";
import { WritingController } from "./writing/controller";
import { nativeBridge } from "./writing/bridge";
import { askClose } from "./writing/dialogs";
import { mountWritingShell } from "./writing/shell";

const root = document.getElementById("app")!;
const controller = new WritingController(nativeBridge, {
  closeDocument: askClose,
  error: (message) => notify.error(message),
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("unhandled rejection", event.reason);
  notify.error(event.reason instanceof Error ? event.reason.message : String(event.reason));
});
window.addEventListener("error", (event) => {
  console.error("uncaught error", event.error ?? event.message);
});
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });

async function start(): Promise<void> {
  try {
    await controller.start();
    const dispose = mountWritingShell(root, controller);
    document.documentElement.style.background = "";
    if (import.meta.hot) import.meta.hot.dispose(dispose);
  } catch (error) {
    console.error("startup", error);
    root.replaceChildren(el("div", { class: "writing-startup", role: "alert" },
      el("p", null, "巧记暂时无法打开"),
      el("p", { class: "quiet-copy" }, error instanceof Error ? error.message : String(error)),
      el("button", { class: "btn", type: "button", onclick: () => location.reload() }, "重试")));
  }
}

void start();
