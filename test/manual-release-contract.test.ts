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
  expect(workflow).toContain("go-version: '1.27.2'");
  expect(workflow).toContain("default: v0.2.20-fork.1");
  expect(workflow).toContain('node scripts/verify-package-assets.mjs');
  expect(workflow).toContain('test -s "$RUNNER_TEMP/plugin-release/package/package-assets.json"');
  expect(workflow).toContain('"$dir/$name" "$dir/package/package-assets.json"');
  expect(workflow).not.toMatch(/SHA256SUMS|\b(?:sha256sum|shasum)\b/);
  expect(workflow).toContain("gh release create");
  expect(workflow).not.toMatch(/git\s+push\b/);
  expect(workflow).not.toMatch(/git\s+commit\b/);
});
