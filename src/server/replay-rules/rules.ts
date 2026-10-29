// The Replay Rules of every Broker Profile (ADR 0011), owned by the server
// like the Checkout manager: their declarations from the profiles file, and
// the last pass of each. For now a pass runs only on demand (Run now, an
// `admin`), and the last pass is kept in memory.
import { HttpError } from '../http-error.js';
import type { CheckoutManager } from '../checkout/manager.js';
import type { BrokerProfile } from '../profiles.js';
import type { ReplayRule, ReplayRuleView, RulePass } from '../../shared/replay-rules.js';
import { runRulePass } from './pass.js';

export class ReplayRules {
  /** `<profile>/<rule>` → its last pass. */
  private readonly lastPasses = new Map<string, RulePass>();

  constructor(private readonly checkouts: CheckoutManager) {}

  /** The rules of `profile`, in file order, with their last pass. */
  list(profile: BrokerProfile): ReplayRuleView[] {
    return profile.replayRules.map((rule) => ({ rule, lastPass: this.lastPasses.get(key(profile, rule.name)) ?? null }));
  }

  /** The rule named `name` of `profile`; throws 404 `replay_rule_not_found`. */
  find(profile: BrokerProfile, name: string): ReplayRule {
    const rule = profile.replayRules.find((r) => r.name === name);
    if (!rule) throw new HttpError(404, 'replay_rule_not_found', `Broker Profile "${profile.name}" has no Replay rule named "${name}".`);
    return rule;
  }

  /**
   * Runs one pass of the rule now and keeps it as its last pass. Throws
   * `replay_rule_not_found`, and what the pass's Checkout start throws (409
   * `checkout_in_progress` with the holder while the queue is held).
   */
  async runNow(profile: BrokerProfile, name: string): Promise<RulePass> {
    const rule = this.find(profile, name);
    const pass = await runRulePass(this.checkouts, profile, rule);
    this.lastPasses.set(key(profile, rule.name), pass);
    return pass;
  }
}

function key(profile: BrokerProfile, rule: string): string {
  return `${profile.name}/${rule}`;
}
