/**
 * `vote` (SPEC §4): one option per member, changeable until close. Live tallies per option
 * (plus per team for `teamSplit`); the game gets the same tallies. No platform-side scoring.
 *
 * @module
 */
import type { PollSpec } from "@sg/engine";
import { BallotPoll, type InputOutcome, type PollEnv, type Voter } from "./types.ts";

/** A `vote` poll. */
export class VotePoll extends BallotPoll<string> {
  constructor(spec: PollSpec) {
    super(spec);
  }

  vote(voter: Voter, choice: string | number, env: PollEnv): InputOutcome {
    if (!this.isOption(choice)) return { ok: false, reason: "invalid" };
    return { ok: true, changed: this.record(voter, choice, env.now) };
  }
}
