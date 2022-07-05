/* eslint-env browser */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
// @ts-ignore
import { MonacoBinding } from "y-monaco";
import * as monaco from "monaco-editor";

window.addEventListener("load", () => {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(
    "wss://demos.yjs.dev",
    "monaco-situ2001",
    ydoc
  );
  const type = ydoc.getText("monaco");

  const editor = monaco.editor.create(
    /** @type {HTMLElement} */ (document.getElementById("monaco-editor")),
    {
      value: "",
      language: "typescript",
      theme: "vs-dark",
    }
  );
  const monacoBinding = new MonacoBinding(
    type,
    /** @type {monaco.editor.ITextModel} */ (editor.getModel()),
    new Set([editor]),
    provider.awareness
  );

  const connectBtn = /** @type {HTMLElement} */ (
    document.getElementById("y-connect-btn")
  );
  connectBtn.addEventListener("click", () => {
    if (provider.shouldConnect) {
      provider.disconnect();
      connectBtn.textContent = "Connect";
    } else {
      provider.connect();
      connectBtn.textContent = "Disconnect";
    }
  });

  // @ts-ignore
  window.example = { provider, ydoc, type, monacoBinding };
});
