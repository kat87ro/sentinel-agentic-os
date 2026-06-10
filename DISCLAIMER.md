# Disclaimer

**Sentinel Agentic OS**

© 2026 Catalin-Adrian Tudor. Please read this disclaimer carefully before
installing, configuring, or operating the Software. By using the Software you
acknowledge and accept everything stated below. This disclaimer supplements, and
does not replace, the terms in [LICENSE.md](LICENSE.md).

---

## 1. "As is", no warranty

The Software is provided **"AS IS" and "AS AVAILABLE", without warranty of any
kind**, express or implied, including but not limited to merchantability, fitness
for a particular purpose, non-infringement, accuracy, reliability, or
uninterrupted operation. You use the Software entirely at your own risk.

## 2. You are responsible for all token usage and costs

The Software orchestrates third-party AI providers and command-line tools (such as
Anthropic Claude, OpenAI/Codex, Google Gemini, OpenRouter, and others). It does
so **using credentials, API keys, accounts, and subscriptions that you supply and
control.**

**The author is not responsible for any cost, charge, token consumption, billing,
overage, or financial loss of any kind arising from your use of the Software**,
including without limitation:

- **a.** token "bursts", runaway loops, or unexpectedly large prompts/responses;
- **b.** automated, recurring, scheduled, delegated, or background activity (for
  example the heartbeat scheduler, multi-agent delegation, retries, or
  self-learning reflection) that consumes tokens without a person watching;
- **c.** charges from any AI provider, API, cloud service, or third-party tool;
- **d.** rate-limit fees, overage fees, plan upgrades, or suspended accounts;
- **e.** costs incurred while the Software is left running unattended.

**Cost control is your responsibility.** You are responsible for choosing your
providers and models, setting and monitoring your own provider-side spending
limits and billing alerts, supervising automated activity, and shutting the
Software down when appropriate.

## 3. The built-in budgets are estimates, not a financial guarantee

The Software includes per-agent budget and cost-analytics features. These are a
**best-effort, estimate-based guardrail** (token counts are approximated, e.g.
from character counts, and metering happens around execution). They are **not** an
accounting system and **not** a hard financial cap. Actual provider charges may
differ from the figures shown, automated or concurrent activity may exceed a
configured allowance before it is enforced, and the legacy chat path may be
ungated unless you configure a chat budget. **Do not rely on the in-app budget as
your only spending control** — always set independent limits with your provider.

## 4. Autonomous and file-system behavior

The Software can run agents autonomously, execute provider CLIs as local processes,
and **write, modify, or delete real files** in the project directories you
configure (a project folder becomes an agent's working directory — it is **not** a
sandbox). You are responsible for the directories, data, and systems you expose to
it, and for reviewing the actions agents take. The author is not liable for data
loss, corruption, unintended file changes, or any consequences of autonomous
agent behavior.

## 5. Security and deployment

The Software is designed for a **single operator on localhost** and binds the
loopback interface by default. If you expose it on a network, run it in
production, or connect it to sensitive systems, **you assume full responsibility**
for securing it (TLS, authentication, network controls, secret management, and
access policy). The author is not responsible for unauthorized access, data
exposure, or damages resulting from your deployment choices.

## 6. Third-party services and outputs

The Software depends on third-party AI providers and tools that are outside the
author's control and subject to their own terms, pricing, availability, and
changes. AI-generated output may be inaccurate, incomplete, or unsuitable for your
purpose; **you are responsible for reviewing and validating any output before
relying on or acting on it.** The author makes no representation about third-party
services and is not responsible for their behavior, costs, or outages.

## 7. No professional advice

Output produced by or through the Software does not constitute legal, financial,
medical, security, or other professional advice. Verify with a qualified
professional before relying on it.

## 8. Limitation of liability

To the maximum extent permitted by applicable law, **in no event shall the author
be liable for any direct, indirect, incidental, special, consequential, punitive,
or exemplary damages** — including but not limited to API/token/usage charges,
financial loss, lost profits, lost data, business interruption, or cost of
substitute services — arising out of or in connection with the Software or its
use, even if advised of the possibility of such damages. Your sole and exclusive
remedy for dissatisfaction with the Software is to stop using it.

## 9. Assumption of risk and indemnity

You assume all risk associated with operating the Software. You agree to indemnify
and hold harmless the author from any claim, cost, or liability arising from your
use of the Software, your provider accounts, or your deployment.

---

By installing or using Sentinel Agentic OS, you confirm that you have read,
understood, and agreed to this disclaimer. If you do not agree, do not use the
Software.

For questions, contact **catalin.adrian.tudor@gmail.com**.
