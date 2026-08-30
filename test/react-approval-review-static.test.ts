import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ApprovalReviewConfirm,
  ApprovalReviewGroup,
  ApprovalReviewItem,
  ApprovalReviewList,
  ApprovalReviewReject,
  ApprovalReviewRoot,
  ApprovalReviewStatus,
  useApprovalReview,
} from "../src/react/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("React ApprovalReview package boundary", () => {
  it("exports the hook and unstyled primitives from the optional React entry", () => {
    expect(typeof useApprovalReview).toBe("function");
    for (const primitive of [
      ApprovalReviewRoot,
      ApprovalReviewList,
      ApprovalReviewGroup,
      ApprovalReviewItem,
      ApprovalReviewStatus,
      ApprovalReviewConfirm,
      ApprovalReviewReject,
    ]) expect(typeof primitive).toBe("object");
  });

  it("imports no styles, provider adapters, browser storage, routing, or application UI", () => {
    const source = readFileSync(
      path.join(packageRoot, "src/react/approval-review.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from\s+|import\s*)["'][^"']*\.(?:css|less|sass|scss)["']/u,
    );
    expect(source).not.toMatch(/(?:^|\/)providers(?:\/|["'])/mu);
    expect(source).not.toMatch(
      /indexeddb|localstorage|sessionstorage|react-router|next\/navigation/iu,
    );
    expect(source).not.toMatch(/(?:^|\/)app(?:lication)?(?:\/|["'])/imu);
  });
});
