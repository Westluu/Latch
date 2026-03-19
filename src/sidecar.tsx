#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import App from "./ui/App.js";

const cwd = process.argv[2] || process.cwd();

render(React.createElement(App, { cwd }));
