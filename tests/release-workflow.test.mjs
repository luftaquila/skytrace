import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/build.yml", import.meta.url), "utf8");

test("release CI publishes one native amd64 and arm64 image index", () => {
  assert.match(workflow, /platform: linux\/amd64\s+runner: ubuntu-24\.04/);
  assert.match(workflow, /platform: linux\/arm64\s+runner: ubuntu-24\.04-arm/);
  assert.match(
    workflow,
    /outputs: type=image,name=\$\{\{ env\.REGISTRY_IMAGE \}\},push-by-digest=true,name-canonical=true,push=true/,
  );
  assert.match(workflow, /needs: build[\s\S]*docker buildx imagetools create/);
  assert.match(workflow, /--tag "\$\{REGISTRY_IMAGE\}:\$\{IMAGE_TAG\}"/);
  assert.match(workflow, /--metadata-file "\$RUNNER_TEMP\/manifest-metadata\.json"/);
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(workflow, /name: release-image-digest/);
});

test("release CI publishes direct Compose assets and only the receiver archive", () => {
  assert.match(workflow, /release:\s+needs: manifest/);
  assert.doesNotMatch(workflow, /scripts\/skytrace-container/);
  assert.match(workflow, /install -m 0644 compose\.yml "\$RUNNER_TEMP\/compose\.yml"/);
  assert.match(workflow, /skytrace\.env\.example/);
  assert.match(workflow, /self-hosting\.md/);
  assert.doesNotMatch(workflow, /skytrace-\$\{IMAGE_TAG\}\.tar\.gz/);
  assert.match(workflow, /skytrace-agent-\$\{IMAGE_TAG\}/);
  assert.match(workflow, /scripts\/package-agent\.sh/);
  assert.match(workflow, /gh release (?:upload|create)/);
  assert.match(workflow, /SKYTRACE_IMAGE=\$\{image_ref\}/);
  assert.match(workflow, /--draft[\s\S]*gh release upload[\s\S]*gh release edit "\$IMAGE_TAG" --draft=false/);
  assert.match(workflow, /Published release \$IMAGE_TAG already exists/);
});

test("release tags match package versions and Compose smoke gates every image build", () => {
  assert.match(workflow, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /root_version=\$\(jq -r \.version package\.json\)/);
  assert.match(workflow, /web_version=\$\(jq -r \.version web\/package\.json\)/);
  assert.match(workflow, /Tag \$IMAGE_TAG does not match package version v\$root_version/);
  assert.match(workflow, /scripts\/smoke-compose\.sh docker/);
  assert.match(workflow, /scripts\/smoke-compose\.sh podman/);
  assert.match(workflow, /Host\.Security\.Rootless/);
  assert.match(workflow, /needs: \[release-test, docker-compose-test, podman-compose-test\]/);
});
