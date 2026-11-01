/**
 * File Formatters Extension
 *
 * Automatically runs a configurable formatter after file write/edit operations.
 * Reads configuration from ~/.pi/agent/formatters.json.
 *
 * Example formatters.json:
 * {
 *    "python": { "extensions": [".py"], "formatter": "ruff format" },
 *    "javascript": { "extensions": [".js", ".jsx", ".ts", ".tsx"], "formatter": "prettier --write" },
 *    "typescript": { "extensions": [".ts", ".tsx"], "formatter": "prettier --write" }
 * }
 *
 * Usage:
 * 1. Create ~/.pi/agent/formatters.json with your formatter config
 * 2. Copy this file to ~/.pi/agent/extensions/
 * 3. The extension will automatically format files after they are written/edited
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const FORMATTERS_CONFIG_FILE = "formatters.json";

interface FormatterConfig {
  extensions: string[];
  formatter: string;
}

interface FormattersConfig {
  [name: string]: FormatterConfig;
}

/**
 * Get the file extension from a path (lowercased)
 */
function getFileExtension(filePath: string): string | null {
  const match = filePath.match(/\.[^.\/\\]+$/);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Find a matching formatter config for a file extension
 */
function findFormatter(extension: string, config: FormattersConfig): FormatterConfig | null {
  for (const configName of Object.keys(config)) {
    const formatterConfig = config[configName];
    if (formatterConfig.extensions.includes(extension)) {
      return formatterConfig;
    }
  }
  return null;
}

/**
 * Format a file using the configured formatter command
 */
async function formatFile(filePath: string, formatter: string, pi: ExtensionAPI): Promise<boolean> {
  // Build the full command by appending the file path
  const fullCommand = `${formatter} ${filePath}`;

  try {
    const result = await pi.exec("bash", ["-c", fullCommand]);
    if (result.code === 0) {
      return true;
    } else {
      console.warn(
        `[file-formatters] Formatter failed for ${filePath}: ${result.stderr || result.stdout || "unknown error"}`,
      );
      return false;
    }
  } catch (error) {
    console.warn(`[file-formatters] Error formatting ${filePath}:`, error);
    return false;
  }
}

/**
 * Check if a tool is a file-writing tool
 */
function isFileWritingTool(toolName: string): boolean {
  const fileWritingTools = ["write", "edit", "file_write", "file_edit"];
  return fileWritingTools.includes(toolName);
}

/**
 * Extract the file path from tool call input
 */
function extractFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "write" || toolName === "file_write") {
    return input.path as string;
  }
  if (toolName === "edit" || toolName === "file_edit") {
    return input.path as string;
  }
  return null;
}

/**
 * Validate that a file path exists and is accessible
 */
async function fileExists(filePath: string, pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("test", ["-f", filePath]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export default function fileFormattersExtension(pi: ExtensionAPI): void {
  // Load formatters configuration once at startup
  let formattersConfig: FormattersConfig | null = null;

  const agentDir = getAgentDir();
  const configPath = `${agentDir}/${FORMATTERS_CONFIG_FILE}`;

  try {
    const fs = require("fs");
    const configContent = fs.readFileSync(configPath, "utf-8");
    formattersConfig = JSON.parse(configContent) as FormattersConfig;
    console.log(
      `[file-formatters] Loaded ${Object.keys(formattersConfig || {}).length} formatter configs`,
    );
  } catch (error) {
    console.warn(
      `[file-formatters] Could not load config from ${configPath}. ` +
        `Formatters will not be applied. Error:`,
      error,
    );
  }

  pi.on("tool_result", async (event, _ctx) => {
    if (!formattersConfig) {
      return;
    }

    // Only run formatters on successful file operations
    if (event.isError) {
      return;
    }

    // Only process file-writing tools
    if (!isFileWritingTool(event.toolName)) {
      return;
    }

    // Extract the file path from the tool input
    const filePath = extractFilePath(event.toolName, event.input);
    if (!filePath) {
      return;
    }

    // Check if the file still exists (it should after a write/edit)
    const exists = await fileExists(filePath, pi);
    if (!exists) {
      return;
    }

    // Get the file extension
    const extension = getFileExtension(filePath);
    if (!extension) {
      return;
    }

    // Find a matching formatter
    const formatterConfig = findFormatter(extension, formattersConfig);
    if (!formatterConfig) {
      return;
    }

    // Run the formatter asynchronously (non-blocking)
    formatFile(filePath, formatterConfig.formatter, pi).catch((err) => {
      console.warn(`[file-formatters] Failed to format ${filePath}:`, err);
    });
  });
}
