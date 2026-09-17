/**
 * Find jobs by id or by the company name a person types.
 *
 * People type "GE Vernova"; the board token is "gevernova" and the display
 * name may be either. Exact company-key matches win over substring hits, so
 * "nice" does not also return every company with "nice" inside its name.
 */
import { ObjectId } from "mongodb";
import { companyKey } from "./warm-path.js";

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function findJobs(
  jobs,
  arg,
  {
    filter = {},
    limit = 10,
    sort = { submitAttemptAt: -1, "llmScore.fit": -1, firstSeenAt: -1 },
  } = {},
) {
  const q = String(arg || "").trim();
  if (!q) return [];
  if (/^[a-f0-9]{24}$/i.test(q)) {
    const j = await jobs.findOne({ $and: [{ _id: new ObjectId(q) }, filter] });
    return j ? [j] : [];
  }
  const words = q.split(/\s+/).map(escRe);
  const rows = await jobs
    .find({
      $and: [
        filter,
        { status: { $ne: "duplicate" } },
        {
          $or: [
            { companyToken: { $regex: words.join("[-_ ]*"), $options: "i" } },
            { companyName: { $regex: words.join("\\s*"), $options: "i" } },
          ],
        },
      ],
    })
    .sort(sort)
    .limit(300)
    .toArray();
  const key = companyKey(q);
  const exact = rows.filter((j) =>
    [j.companyName, j.companyToken].some((x) => companyKey(x) === key),
  );
  return (exact.length ? exact : rows).slice(0, limit);
}
