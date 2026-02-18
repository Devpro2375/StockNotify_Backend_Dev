// services/upstoxTokenRefresh.js

const { spawn, execSync } = require("child_process");
const path = require("path");
const AccessToken = require("../models/AccessToken");

class UpstoxTokenRefresh {
  /**
   * Find a working Python command.
   * Windows: python → py → python3
   * Linux:   /opt/venv/bin/python3 → /opt/venv/bin/python → python3 → python
   */
  _findPythonCommand() {
    const fs = require("fs");

    const candidates =
      process.platform === "win32"
        ? ["python", "py", "python3"]
        : [
          "/opt/venv/bin/python3", // Railway venv (nixpacks) — python3 symlink
          "/opt/venv/bin/python",  // Railway venv (nixpacks) — python symlink
          "python3",               // Linux system
          "python",                // Fallback
        ];

    for (const cmd of candidates) {
      try {
        // For absolute paths, check file exists first
        if (cmd.startsWith("/") && !fs.existsSync(cmd)) {
          console.log(`[Token Refresh] ${cmd} does not exist, skipping`);
          continue;
        }
        execSync(`${cmd} --version`, {
          stdio: "pipe",
          timeout: 5000,
          shell: true,
        });
        console.log(`[Token Refresh] ✓ Using Python command: ${cmd}`);
        return cmd;
      } catch (err) {
        console.log(`[Token Refresh] ✗ ${cmd} failed: ${err.message?.split("\n")[0]}`);
      }
    }

    // Diagnostic info for debugging on Railway
    console.error("[Token Refresh] === PYTHON DIAGNOSTIC INFO ===");
    console.error(`[Token Refresh] Platform: ${process.platform}`);
    console.error(`[Token Refresh] PATH: ${process.env.PATH}`);
    try {
      const venvDir = "/opt/venv/bin";
      if (fs.existsSync(venvDir)) {
        console.error(`[Token Refresh] ${venvDir} contents: ${fs.readdirSync(venvDir).join(", ")}`);
      } else {
        console.error(`[Token Refresh] ${venvDir} does NOT exist`);
      }
    } catch (e) {
      console.error(`[Token Refresh] Could not list venv dir: ${e.message}`);
    }
    console.error("[Token Refresh] =============================");

    throw new Error(
      "Python not found. Tried: " + candidates.join(", ") +
      ". Check Railway build logs — the venv may not have been created."
    );
  }

  async refreshToken() {
    const startTime = Date.now();
    const TIMEOUT_MS = 120_000; // 2-minute timeout

    return new Promise((resolve) => {
      try {
        console.log("[Token Refresh] ========================================");
        console.log(`[Token Refresh] Starting at ${new Date().toISOString()}`);

        // Find a working Python binary
        let pythonCmd;
        try {
          pythonCmd = this._findPythonCommand();
        } catch (findErr) {
          console.error(`[Token Refresh] ✗ ${findErr.message}`);
          console.error("[Token Refresh] ========================================");
          return resolve({ success: false, error: findErr.message });
        }

        const scriptPath = path.join("python-scripts", "refresh_upstox_token.py");
        console.log(`[Token Refresh] Running: ${pythonCmd} ${scriptPath}`);

        const pythonProcess = spawn(pythonCmd, [scriptPath], {
          env: process.env,
          cwd: process.cwd(),
          shell: true, // Required on Windows for PATH resolution
        });

        let output = "";
        let errorOutput = "";

        // Timeout guard — kill the process if it runs too long
        const timer = setTimeout(() => {
          console.error(
            `[Token Refresh] ✗ Timeout after ${TIMEOUT_MS / 1000}s — killing process`
          );
          pythonProcess.kill("SIGKILL");
        }, TIMEOUT_MS);

        pythonProcess.stdout.on("data", (data) => {
          const text = data.toString();
          output += text;
          text
            .split("\n")
            .filter((line) => line.trim())
            .forEach((line) => console.log("[Python] " + line));
        });

        pythonProcess.stderr.on("data", (data) => {
          const text = data.toString();
          errorOutput += text;
          console.error("[Python Error] " + text);
        });

        pythonProcess.on("close", async (code) => {
          clearTimeout(timer);
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);

          if (code === 0) {
            console.log(
              "[Token Refresh] ✓ Python script completed successfully"
            );

            try {
              const tokenDoc = await AccessToken.findOne();
              if (tokenDoc?.token) {
                console.log("[Token Refresh] ✓ Token verified in MongoDB");
                console.log(
                  `[Token Refresh] User: ${tokenDoc.user_name || "N/A"}`
                );
                console.log(
                  `[Token Refresh] Expires: ${tokenDoc.expires_at || "N/A"}`
                );
                console.log(`[Token Refresh] Duration: ${duration}s`);
                console.log(
                  "[Token Refresh] ========================================"
                );

                resolve({
                  success: true,
                  expiresAt: tokenDoc.expires_at,
                  duration,
                });
              } else {
                throw new Error("Token not found in database after refresh");
              }
            } catch (dbError) {
              console.error(
                "[Token Refresh] ✗ Database verification failed:",
                dbError.message
              );
              resolve({
                success: false,
                error:
                  "Token refresh completed but database verification failed",
              });
            }
          } else {
            console.error(
              `[Token Refresh] ✗ Python script failed with code ${code}`
            );
            console.error(`[Token Refresh] stderr: ${errorOutput}`);
            console.error(`[Token Refresh] Duration: ${duration}s`);
            console.error(
              "[Token Refresh] ========================================"
            );

            resolve({
              success: false,
              error: `Python script exited with code ${code}`,
              output: errorOutput || output,
            });
          }
        });

        pythonProcess.on("error", (error) => {
          clearTimeout(timer);
          console.error(
            "[Token Refresh] ✗ Failed to spawn Python process:",
            error.message
          );
          console.error(
            "[Token Refresh] ========================================"
          );

          resolve({
            success: false,
            error: `Failed to run Python: ${error.message}`,
            note: "Make sure Python is installed and in PATH",
          });
        });
      } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(
          `[Token Refresh] ✗ Error after ${duration}s:`,
          error.message
        );
        console.error(
          "[Token Refresh] ========================================"
        );

        resolve({ success: false, error: error.message });
      }
    });
  }
}

module.exports = UpstoxTokenRefresh;
