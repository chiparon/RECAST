// Candidate programs inherit the native toolchain environment, without the model
// provider credentials, their filenames or unrelated account tokens.
import { spawn } from "node:child_process";
const keys =
  /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|localappdata|appdata|userprofile|home|programfiles(?:\(x86\))?|programdata|lang|lc_all|java_home|dotnet_root|virtual_env|conda_prefix|pythonpath)$/i;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => keys.test(key)),
);
const [executable, ...args] = process.argv.slice(2);
const child = spawn(executable, args, {
  stdio: "inherit",
  env,
  windowsHide: true,
  shell: false,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
