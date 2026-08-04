// SPDX-License-Identifier: MIT OR Apache-2.0
export const args = () => process.argv.slice(2);
export const currentDirectory = () => process.cwd();
export const platform = () => process.platform;
export const architecture = () => process.arch;
export const setExitCode = value => { process.exitCode = Number(value); };
