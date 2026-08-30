import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ConversationPickerList,
  ConversationPickerRoot,
  useConversationPicker,
} from "../src/react/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("React ConversationPicker package boundary", () => {
  it("exports the hook and primitives from the optional React entry", () => {
    expect(typeof useConversationPicker).toBe("function");
    expect(typeof ConversationPickerRoot).toBe("object");
    expect(typeof ConversationPickerList).toBe("object");
  });

  it("imports no styles, provider adapters, persistence, or application navigation", () => {
    const source = readFileSync(
      path.join(packageRoot, "src/react/conversation-picker.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from\s+|import\s*)["'][^"']*\.(?:css|less|sass|scss)["']/u,
    );
    expect(source).not.toMatch(/(?:^|\/)providers(?:\/|["'])/mu);
    expect(source).not.toMatch(/indexeddb|localstorage|sessionstorage|react-router|next\/navigation/iu);
  });
});
