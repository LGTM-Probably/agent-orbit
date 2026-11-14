import { GraphStore } from "./graphStore";
import { TranscriptTailer } from "./tailer";

const t0 = Date.now();
const store = new GraphStore();
store.setTimeWindow("24h");
const tailer = new TranscriptTailer(store);
tailer.discoverFiles(false);

const snap = store.getSnapshot();
const elapsed = Date.now() - t0;

console.log(`Scanned ${tailer.getTrackedFileCount()} recent JSONL files in ${elapsed}ms`);
console.log(`Active/24h graph nodes: ${snap.nodes.length} (total tracked: ${store.getAllNodesCount()})`);

const byHarness: Record<string, number> = {};
for (const n of snap.nodes) {
  byHarness[n.harness] = (byHarness[n.harness] ?? 0) + 1;
}
console.log("By harness:", byHarness);

for (const n of snap.nodes.slice(0, 12)) {
  console.log(
    `  [${n.harness}] ${n.isSubagent ? "↳ SUB " : "★ ROOT"} "${n.label}" | proj=${n.project} | status=${n.status} | tools=${n.totalToolCalls} | skills=[${n.skills.map(s => s.name).join(", ")}]${n.parentId ? " | parent=" + n.parentId.slice(0, 16) : ""}`
  );
}
