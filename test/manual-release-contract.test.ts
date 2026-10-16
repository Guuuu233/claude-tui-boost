import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";

test("manual release cannot patch/push Magpie or publish from an unmerged PR branch", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish-v0.1.0.yml", import.meta.url), "utf8");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("refs/heads/main");
  expect(workflow).toContain("v\"+p.version");
  expect(workflow).toContain("-buildvcs=false");
  expect(workflow).toContain("cmp \"$dir/$kind.$os-$arch\" \"bin/$kind.$os-$arch\"");
  expect(workflow).toContain("npm pack --silent");
  expect(workflow).toContain("PLUGIN_SHA256SUMS");
  expect(workflow).toContain("gh release create");
  expect(workflow).not.toMatch(/git\s+push\b/);
  expect(workflow).not.toMatch(/git\s+commit\b/);
});
