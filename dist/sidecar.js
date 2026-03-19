#!/usr/bin/env node
import { jsx as _jsx } from "react/jsx-runtime";
import { render } from "ink";
import App from "./ui/App.js";
const cwd = process.argv[2] || process.cwd();
render(_jsx(App, { cwd: cwd }));
//# sourceMappingURL=sidecar.js.map