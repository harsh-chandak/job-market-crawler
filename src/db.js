/**
 * Single-user Mongo connection.
 *
 * Deliberately NOT the master/tenant split from job-alerts — there is one user,
 * one database. Everything lives in DB_NAME.
 */

import "dotenv/config";
import { MongoClient } from "mongodb";

const DB_NAME = process.env.DB_NAME || "job_hunt";

let client = null;
let db = null;
let indexesReady = false;

/**
 * Turn a Mongo driver failure into something a human can act on.
 *
 * The raw MongoServerSelectionError prints roughly 200 lines — a nested
 * ServerDescription per replica-set member, each carrying the same cause — and
 * the one actionable fact is buried. Worse, the most common failure by far has
 * a misleading signature: when Atlas rejects a client because its IP is not in
 * the Access List, it accepts the TCP connection and then kills the TLS
 * handshake with alert 80 (internal_error). That reads like a certificate or
 * OpenSSL problem and sends you debugging the wrong thing entirely.
 *
 * Diagnosed once, live: TCP to :27017 succeeded, the handshake wrote 1573 bytes
 * and read 7 before the alert. Network fine, Atlas refusing.
 */
function explain(err) {
  const raw = String(err?.message || "");
  const cause = String(err?.cause?.message || "");
  const text = `${raw} ${cause}`;

  let diagnosis;
  if (/alert number 80|tlsv1 alert internal error|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR/.test(text)) {
    diagnosis = [
      "Atlas refused the TLS handshake. This almost always means THIS MACHINE'S",
      "CURRENT IP IS NOT IN THE ATLAS IP ACCESS LIST — it is not a certificate",
      "or OpenSSL fault, despite how the error reads.",
      "",
      "It happens when you change networks: home, campus, phone hotspot and",
      "coffee shop are all different IPs.",
      "",
      "Fix:",
      "  1. https://cloud.mongodb.com  ->  your project",
      "  2. Security -> Network Access -> IP Access List",
      "  3. ADD IP ADDRESS -> Add Current IP Address -> Confirm",
      "  4. Wait for the entry to go Active, then run this again",
    ].join("\n  ");
  } else if (/ENOTFOUND|EAI_AGAIN|querySrv/.test(text)) {
    diagnosis =
      "DNS lookup for the Atlas cluster failed. Check the internet connection,\n" +
      "  and check MONGODB_URI in .env for a typo in the hostname.";
  } else if (/Authentication failed|bad auth/i.test(text)) {
    diagnosis =
      "Atlas rejected the username or password in MONGODB_URI.\n" +
      "  Reset it under Security -> Database Access and update .env.";
  } else if (/ECONNREFUSED|ETIMEDOUT|timed out/i.test(text)) {
    diagnosis =
      "Could not reach Atlas at all. Either the network blocks outbound port\n" +
      "  27017 (common on locked-down corporate and campus wifi) or the cluster\n" +
      "  is paused. Check the cluster is running, then try another network.";
  } else {
    return err; // unknown shape — keep the original rather than guess
  }

  const e = new Error(`Cannot reach MongoDB.\n\n  ${diagnosis}\n`);
  e.name = "MongoUnreachable";
  e.cause = err;
  e.diagnosed = true;
  return e;
}

export async function getDb() {
  if (db) return db;

  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("Missing MONGODB_URI (see .env.example)");

  if (!client)
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });

  try {
    await client.connect();
    db = client.db(DB_NAME);
    await db.command({ ping: 1 });
  } catch (err) {
    // Never keep a poisoned singleton around — the next call should reconnect.
    try {
      await client.close();
    } catch {}
    client = null;
    db = null;
    indexesReady = false;
    throw explain(err);
  }

  if (!indexesReady) await ensureIndexes(db);
  return db;
}

export async function ensureIndexes(database) {
  const companies = database.collection("companies");
  const jobs = database.collection("jobs");
  const pollLog = database.collection("poll_log");
  const contacts = database.collection("contacts");

  await Promise.all([
    // one row per board
    companies.createIndex({ ats: 1, token: 1 }, { unique: true }),
    // the poller's hot path: "what is due right now, most overdue first"
    companies.createIndex({ enabled: 1, nextPollAt: 1 }),
    companies.createIndex({ tier: 1, nextPollAt: 1 }),
    companies.createIndex({ name: 1 }),

    // idempotent upserts from any adapter
    jobs.createIndex(
      { ats: 1, companyToken: 1, sourceJobId: 1 },
      { unique: true },
    ),
    // freshness + dedup
    jobs.createIndex({ firstSeenAt: -1 }),
    jobs.createIndex({ clusterKey: 1 }),
    jobs.createIndex({ contentHash: 1 }),
    jobs.createIndex({ status: 1, firstSeenAt: -1 }),

    pollLog.createIndex({ startedAt: -1 }),
    pollLog.createIndex({ companyKey: 1, startedAt: -1 }),

    // warm path: one row per person per employer (scripts/warm-path.mjs)
    contacts.createIndex({ nameNorm: 1, companyKey: 1 }, { unique: true }),
    contacts.createIndex({ companyKey: 1 }),
    contacts.createIndex({ status: 1, nextTouchAt: 1 }),
  ]);

  indexesReady = true;
  return database;
}

export async function closeDb() {
  if (client) {
    try {
      await client.close();
    } catch {}
  }
  client = null;
  db = null;
  indexesReady = false;
}
