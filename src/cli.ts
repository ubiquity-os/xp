#!/usr/bin/env bun

import { createClient } from "@supabase/supabase-js";
import { BigNumber } from "@ethersproject/bignumber";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Octokit } from "@octokit/rest";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GITHUB_TOKEN) {
  throw new Error("Missing SUPABASE_URL, SUPABASE_ANON_KEY, or GITHUB_TOKEN in environment");
}

// Initialize Supabase and Octokit clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Interfaces
export interface SupabasePermit {
  id: number;
  nonce: string;
  amount: string;
  deadline: string;
  signature: string;
  transaction: string | null;
  token_id: number | null;
  beneficiary_id: number | null;
  partner_id: number | null;
  location_id: number | null;
}

export interface SupabaseUser {
  id: number;
  wallet_id: number;
}

export interface SupabaseLocation {
  id: number;
  node_url: string;
}

export interface Location {
  org: string;
  repo: string;
}

/** Fetch the GitHub user ID for a given username */
async function fetchGitHubUserId(username: string): Promise<number | null> {
  try {
    const response = await octokit.users.getByUsername({ username });
    return response.data.id;
  } catch (error) {
    console.error(`Error fetching GitHub user ${username}:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Fetch permits from Supabase for a given user ID */
async function fetchPermitsForUser(userId: number): Promise<SupabasePermit[] | null> {
  try {
    const { data: permits, error } = await supabase.from("permits").select("nonce, amount, location_id").eq("beneficiary_id", userId);

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }

    return permits as SupabasePermit[];
  } catch (error) {
    console.error("Error fetching permits:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Fetch and parse location details from Supabase by ID */
async function fetchLocationById(id: number): Promise<Location | null> {
  try {
    const { data: location, error } = await supabase.from("locations").select("node_url").eq("id", id);

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }

    if (!location || location.length === 0) {
      console.error(`No location found with ID ${id}`);
      return null;
    }

    const nodeUrl = location[0].node_url;
    const urlRegex = new RegExp("github\\.com/([^/]+)/([^/]+)");
    const match = nodeUrl.match(urlRegex);

    if (!match || match.length < 3) {
      console.error(`Could not parse GitHub URL: ${nodeUrl}`);
      return null;
    }

    return { org: match[1], repo: match[2] };
  } catch (error) {
    console.error("Error fetching location:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Filter permits by organization and/or repository */
async function filterPermitsByLocation(permits: SupabasePermit[], org?: string, repo?: string): Promise<SupabasePermit[]> {
  if (!org && !repo) return permits;

  const filteredPermits: SupabasePermit[] = [];
  for (const permit of permits) {
    if (!permit.location_id) continue;
    const location = await fetchLocationById(permit.location_id);
    if (!location) continue;
    if (location.org === org && (!repo || location.repo === repo)) {
      filteredPermits.push(permit);
    }
  }
  return filteredPermits;
}

/** Calculate XP for a GitHub user, optionally filtered by org/repo */
async function calculateXp(username: string, org?: string, repo?: string): Promise<void> {
  try {
    const userId = await fetchGitHubUserId(username);
    if (!userId) {
      console.error(`Could not find GitHub user ${username}`);
      return;
    }

    let permits = await fetchPermitsForUser(userId);
    if (!permits) {
      console.error(`No permits found for GitHub user ${username}`);
      return;
    }

    if (org || repo) {
      if (repo && !org) {
        throw new Error("Organization must be specified when repository is provided");
      }
      permits = await filterPermitsByLocation(permits, org, repo);
    }

    const xp = calculateXpFromPermits(permits);
    console.log(`User: ${username}`);
    if (org && repo) {
      console.log(`Repository (${org}/${repo}) XP: ${xp}`);
    } else if (org) {
      console.log(`Organization (${org}) XP: ${xp}`);
    } else {
      console.log(`Global XP: ${xp}`);
    }
  } catch (error) {
    console.error("Error calculating XP:", error instanceof Error ? error.message : String(error));
  }
}

/** Calculate total XP from an array of permits */
function calculateXpFromPermits(permits: SupabasePermit[]): number {
  const total = permits.reduce((sum, permit) => sum.add(BigNumber.from(permit.amount)), BigNumber.from(0));
  return Number(total.div(BigNumber.from(10).pow(18)));
}

// CLI configuration
void yargs(hideBin(process.argv))
  .command(
    "calculate",
    "Calculate XP for a GitHub user",
    (yargs) => {
      return yargs
        .option("user", {
          type: "string",
          demandOption: true,
          describe: "GitHub username to calculate XP for",
        })
        .option("org", {
          type: "string",
          describe: "Filter XP by GitHub organization",
        })
        .option("repo", {
          type: "string",
          describe: "Filter XP by GitHub repository (requires --org)",
        })
        .check((argv) => {
          if (argv.repo && !argv.org) {
            throw new Error("Organization (--org) must be specified when repository (--repo) is provided");
          }
          return true;
        });
    },
    async (argv) => {
      await calculateXp(argv.user, argv.org, argv.repo);
    }
  )
  .demandCommand(1, "You need to specify a command.")
  .example("$0 calculate --user 0x4007", "Calculate global XP for user '0x4007'")
  .example("$0 calculate --user 0x4007 --org ubiquity", "Calculate XP for '0x4007' in 'ubiquity' org")
  .example("$0 calculate --user 0x4007 --org ubiquity --repo work.ubq.fi", "Calculate XP for '0x4007' in 'ubiquity/work.ubq.fi'")
  .help()
  .parse();
