// Solid and OpenTUI are provided by the OpenCode host, not bundled here.
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal, For } from "solid-js";
import { compactLine, dashboardLines } from "./model.js";
import { percentageParts } from "./colors.js";
import { loadConfig } from "./config.js";
import { createCollectors } from "./collectors.js";

const SLOTS = ["prompt.footer", "home.footer"];
const ROUTE = "opencode-usage.limits.dashboard";

export default {
  id: "opencode-usage",
  setup(ctx) {
    const { config, error: configError } = loadConfig();
    const { fetchGo, fetchClipProxy } = createCollectors(config);
    const muted = ctx.theme.text.muted ?? ctx.theme.text.base;
    const colored = (text) => percentageParts(text).map((part) =>
      jsx("span", { ...(part.color ? { style: { fg: part.color } } : {}), children: part.text }));
    const [state, setState] = createSignal({
      go: config.opencodeGo.enabled ? undefined : { enabled: false },
      cpa: config.cliproxyapi.enabled ? undefined : { enabled: false },
    });
    let claims = [];
    let disposed = false;
    let pending;
    let previousRoute;
    const close = () => ctx.ui.router.navigate(previousRoute ?? { type: "home" });
    const open = () => {
      const current = ctx.ui.router.current();
      if (current.type !== "plugin" || current.name !== ROUTE) previousRoute = { ...current };
      ctx.ui.router.navigate({ type: "plugin", name: ROUTE });
    };
    const unmount = () => {
      for (const claim of claims) claim();
      claims = [];
    };
    const click = (action) => (event) => {
      if (event.button !== 0 || event.isDragging) return;
      event.stopPropagation?.();
      action();
    };
    const mount = () => {
      unmount();
      const { go, cpa } = state();
      claims = SLOTS.map((slot) => ctx.ui.slot({
        before: slot,
        render: (input) => slot === "prompt.footer" && !input.sessionID ? null : jsx("box", {
          flexDirection: "row", flexWrap: "wrap", onMouseDown: click(open),
          children: compactLine(go, cpa).split(" · ").map((part, index) =>
            jsx("text", {
              fg: muted, wrapMode: "none", selectable: false, flexShrink: 0,
              children: colored(`${index ? " · " : ""}${part}`),
            })),
        }),
      }));
    };
    const refresh = () => {
      if (pending) return pending;
      pending = Promise.all([fetchGo(), fetchClipProxy()]).then(([go, cpa]) => {
        if (disposed) return;
        setState({ go, cpa, updatedAt: Date.now() });
        mount();
      }).finally(() => { pending = undefined; });
      return pending;
    };
    const unregisterRoute = ctx.ui.router.register({
      name: ROUTE,
      render: () => {
        ctx.keymap.layer(() => ({ commands: [
          { bind: "escape", run: close },
          { bind: "r", run: () => void refresh() },
        ] }));
        return jsx("box", {
          flexDirection: "column", width: "100%", height: "100%", padding: 1,
          children: [
            jsx("text", { fg: ctx.theme.text.base, children: "Limits — remaining quota" }),
            jsx("box", { flexDirection: "row", gap: 3, marginBottom: 1, children: [
              jsx("text", { fg: muted, onMouseDown: click(close), children: "[Esc] Back" }),
              jsx("text", { fg: muted, onMouseDown: click(() => void refresh()), children: "[R] Refresh" }),
            ] }),
            jsx("scrollbox", { flexGrow: 1, children: jsx(For, {
              get each() {
                const value = state();
                return dashboardLines(value.go, value.cpa, value.updatedAt, Date.now(), { refreshMs: config.refreshMs, configError });
              },
              children: (line) => jsx("text", { fg: ctx.theme.text.base, wrapMode: "word", children: colored(line || " ") }),
            }) }),
          ],
        });
      },
    });
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "opencode-usage.limits.open", title: "Show account limits", palette: true,
      slash: { name: "limits" }, run: open,
    }] }));
    mount();
    void refresh();
    const timer = setInterval(() => void refresh(), config.refreshMs);
    timer.unref?.();
    return () => {
      disposed = true;
      clearInterval(timer);
      unmount();
      unregisterRoute();
    };
  },
};
