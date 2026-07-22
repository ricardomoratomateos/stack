import { exec } from 'node:child_process';
import { ExecOptions, IProcessRunner } from '../ports/IProcessRunner';

/** IProcessRunner implementation backed by node:child_process exec. */
export class NodeProcessRunner implements IProcessRunner {
  exec(cmd: string, options: ExecOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv | undefined,
          timeout: options.timeout,
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
  }
}
