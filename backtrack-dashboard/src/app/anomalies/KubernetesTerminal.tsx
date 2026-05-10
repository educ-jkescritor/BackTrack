"use client";
import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

export default function AnomalyTerminal({ clusterName }: { clusterName?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const term = new Terminal({
      theme: {
        background:   "#07090d",
        foreground:   "#c9d3e0",
        cursor:       "#5eead4",
        cursorAccent: "#07090d",
        black:        "#0b1018",
        brightBlack:  "#3d4a5c",
        red:          "#fb7185",
        brightRed:    "#fca5a5",
        green:        "#34d399",
        brightGreen:  "#6ee7b7",
        yellow:       "#fbbf24",
        brightYellow: "#fcd34d",
        blue:         "#60a5fa",
        brightBlue:   "#93c5fd",
        magenta:      "#a78bfa",
        brightMagenta:"#c4b5fd",
        cyan:         "#5eead4",
        brightCyan:   "#67e8f9",
        white:        "#a5b0c2",
        brightWhite:  "#e6edf6",
      },
      fontSize: 12,
      fontFamily: '"IBM Plex Mono", "JetBrains Mono", Monaco, Menlo, monospace',
      cursorBlink: true,
      cursorStyle: "bar",
      lineHeight: 1.6,
      letterSpacing: 0,
      cols: 120,
      rows: 30,
      scrollback: 2000,
      allowTransparency: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    if (term.element) {
      term.element.style.overflow = "hidden";
    }

    setTimeout(() => {
      try {
        fit.fit();
      } catch (e) {
        console.warn("Failed to fit terminal:", e);
      }
    }, 100);

    term.writeln("\x1b[2m" + "─".repeat(64) + "\x1b[0m");
    term.writeln(`\x1b[36;1m  BackTrack \x1b[0m\x1b[2m·\x1b[0m\x1b[36m kubectl \x1b[0m\x1b[2m· ${clusterName || "local"}\x1b[0m`);
    term.writeln("\x1b[2m" + "─".repeat(64) + "\x1b[0m");
    term.writeln("\x1b[2mType kubectl commands. Tab to complete. Ctrl+C to cancel.\x1b[0m");
    term.writeln("");

    let currentCommand = "";

    // Handle user input
    term.onData((data) => {
      if (data === "\r") {
        // Enter key - execute command
        term.writeln("");

        if (currentCommand.trim()) {
          executeCommand(currentCommand);
        }

        currentCommand = "";
        term.write("\x1b[32m$\x1b[0m ");
      } else if (data === "\u007F") {
        // Backspace
        if (currentCommand.length > 0) {
          currentCommand = currentCommand.slice(0, -1);
          term.write("\b \b");
        }
      } else if (data === "\u0003") {
        // Ctrl+C
        currentCommand = "";
        term.writeln("^C");
        term.write("\x1b[32m$\x1b[0m ");
      } else {
        // Regular character
        currentCommand += data;
        term.write(data);
      }
    });

    const executeCommand = async (command: string) => {
      term.writeln("\x1b[90m" + "─".repeat(60) + "\x1b[0m");

      try {
        const response = await fetch("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });

        const result = await response.json();

        if (result.output) {
          // Parse and format output
          const lines = result.output.split("\n");
          lines.forEach((line: string) => {
            if (line.includes("Running")) {
              term.writeln("\x1b[32m" + line + "\x1b[0m"); // Green for Running
            } else if (
              line.includes("Error") ||
              line.includes("CrashLoopBackOff")
            ) {
              term.writeln("\x1b[31m" + line + "\x1b[0m"); // Red for errors
            } else if (line.includes("Pending")) {
              term.writeln("\x1b[33m" + line + "\x1b[0m"); // Yellow for Pending
            } else if (line.includes("NAME") || line.includes("NAMESPACE")) {
              term.writeln("\x1b[36m" + line + "\x1b[0m"); // Cyan for headers
            } else {
              term.writeln(line);
            }
          });
        }

        if (result.error && result.error.trim()) {
          term.writeln("\x1b[31mError: " + result.error + "\x1b[0m");
        }

        term.writeln("\x1b[90m" + "─".repeat(60) + "\x1b[0m");
        term.write("\x1b[32m$\x1b[0m ");
      } catch (error: unknown) {
        term.writeln("\x1b[31mConnection error: " + (error instanceof Error ? error.message : String(error)) + "\x1b[0m");
        term.write("\x1b[32m$\x1b[0m ");
      }
    };

    term.write("\x1b[32m$\x1b[0m ");

    const handleResize = () => {
      try {
        fit.fit();
      } catch (e) {
        console.warn("Failed to fit on resize:", e);
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
    };
  }, [clusterName]);

  return <div className="h-full w-full" ref={ref} />;
}
