import { spawn } from "node:child_process";

export function runCommand(command: string, args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(command, args, { shell: false });
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			resolve({ code: 1, stdout: "", stderr: error.message });
		});

		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}
