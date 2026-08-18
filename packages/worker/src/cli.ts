#!/usr/bin/env node
import { runCli } from "./scheduler.js";

const args = process.argv.slice(2);
runCli(args).catch((e) => {
  console.error(e);
  process.exit(1);
});
