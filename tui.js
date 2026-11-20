// Solid and OpenTUI are provided by the OpenCode host, not bundled here.
import { jsx } from "@opentui/solid/jsx-runtime";
import { useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";
import { adaptiveGroups, dashboardLines, footerAvailableWidth } from "./model.js";
import { compactPercentageParts, percentageParts } from "./colors.js";
import { loadConfig } from "./config.js";
import { createCollectors } from "./collectors.js";

const ROUTE = "opencode-usage.limits.dashboard";

export default {
  id: "opencode-usage",
  setup(ctx) {
    const { config, error: configError } = loadConfig();
    const { fetchGo, fetchClipProxy, fetchProjectCosts } = createCollectors(config);
    const muted = ctx.theme.text.muted ?? ctx.theme.text.base;
    const colored = (text, compact = false) => (compact ? compactPercentageParts(text) : percentageParts(text)).map((part) =>
      jsx("span", { ...(part.color ? { style: { fg: part.color } } : {}), children: part.text }));
    const [state, setState] = createSignal({
      go: config.opencodeGo.enabled ? undefined : { enabled: false },
      cpa: config.cliproxyapi.enabled ? undefined : { enabled: false },
      costs: config.openaiProjectCosts.enabled ? { ok: false, error: "loading" } : { enabled: false },
    });
    let disposed = false;
    let pending;
    let previousRoute;
    const close = () => ctx.ui.router.navigate(previousRoute ?? { type: "home" });
    const open = () => {
      const current = ctx.ui.router.current();
      if (current.type !== "plugin" || current.name !== ROUTE) previousRoute = { ...current };
      ctx.ui.router.navigate({ type: "plugin", name: ROUTE });
      void refreshCosts();
    };
    const click = (action) => (event) => {
      if (event.button !== 0 || event.isDragging) return;
      event.stopPropagation?.();
      action();
    };
    const render = () => {
      const dimensions = useTerminalDimensions();
      const [width, setWidth] = createSignal();
      const padding = () => dimensions().width < 44 && ctx.ui.router.current().type === "session" ? 1 : 2;
      const measure = typeof Bun !== "undefined" && Bun.stringWidth ? Bun.stringWidth : (text) => text.length;
      // The full-width app slot is below the route, unlike prompt.footer,
      // which is inside the host's horizontal status row. Measure the slot's
      // allocated width (not its content) so tab rails do not skew the fit.
      return jsx(Show, {
        get when() { return ["home", "session"].includes(ctx.ui.router.current().type); },
        get children() {
          return jsx("box", {
            width: "100%", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", onMouseDown: click(open),
            get paddingLeft() { return padding(); },
            get paddingRight() { return padding(); },
            onSizeChange() {
              const allocated = this.width;
              queueMicrotask(() => setWidth(allocated));
            },
            get children() {
              const { go, cpa } = state();
              return adaptiveGroups(go, cpa, footerAvailableWidth(width(), padding()), measure).map((part, index) =>
                jsx("text", {
                  fg: muted, wrapMode: "none", selectable: false, flexShrink: 0,
                  children: colored(`${index ? "  " : ""}${part}`, true),
                }));
            },
          });
        },
      });
    };
    const refresh = () => {
      if (pending) return pending;
      pending = Promise.all([fetchGo(), fetchClipProxy()]).then(([go, cpa]) => {
        if (disposed) return;
        setState({ ...state(), go, cpa, updatedAt: Date.now() });
      }).finally(() => { pending = undefined; });
      return pending;
    };
    const refreshCosts = () => fetchProjectCosts().then((costs) => {
      if (!disposed) setState({ ...state(), costs });
    });
    const refreshDashboard = () => { void refresh(); void refreshCosts(); };
    const unregisterRoute = ctx.ui.router.register({
      name: ROUTE,
      render: () => {
        ctx.keymap.layer(() => ({ commands: [
          { bind: "escape", run: close },
          { bind: "r", run: refreshDashboard },
        ] }));
        return jsx("box", {
          flexDirection: "column", width: "100%", height: "100%", padding: 1,
          children: [
            jsx("text", { fg: ctx.theme.text.base, children: config.openaiProjectCosts.enabled ? "Limits — quota and project spend" : "Limits — remaining quota" }),
            jsx("box", { flexDirection: "row", gap: 3, marginBottom: 1, children: [
              jsx("text", { fg: muted, onMouseDown: click(close), children: "[Esc] Back" }),
              jsx("text", { fg: muted, onMouseDown: click(refreshDashboard), children: "[R] Refresh" }),
            ] }),
            jsx("scrollbox", { flexGrow: 1, children: jsx(For, {
              get each() {
                const value = state();
                return dashboardLines(value.go, value.cpa, value.updatedAt, Date.now(), { refreshMs: config.refreshMs, configError, costs: value.costs });
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
    const unmount = ctx.ui.slot({ append: "app", render });
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
