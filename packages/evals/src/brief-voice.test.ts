import { describe, expect, it } from "vitest";
import { extractFocusVoice } from "@second-brain/agents";

describe("extractFocusVoice", () => {
  it("takes the first 2–3 Focus bullets", () => {
    const md = `# Morning
## Focus
- **Ship** the widget toast
- Reply to Sara on hiring
- Ignore this fourth bullet
## Calendar
- 10:00 standup
`;
    expect(extractFocusVoice(md)).toBe(
      "Ship the widget toast · Reply to Sara on hiring · Ignore this fourth bullet",
    );
  });

  it("returns null when Focus is empty", () => {
    expect(extractFocusVoice("## Calendar\n- none")).toBeNull();
  });
});
