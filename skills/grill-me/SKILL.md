---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree, while persisting every question and answer to a transcript file so context is never lost. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
version: 1.0.0
author: claude-global
tags: []
mirrored_at: 2026-06-10T08:54:36.383943+00:00
---

Interview me relentlessly about every aspect of this plan until we reach a shared
understanding. Walk down each branch of the design tree, resolving dependencies
between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Persisting the session (so context is never lost)

This is a long, branching interview. To survive context compaction, an interrupted
session, or simply a very long grilling, **persist the transcript to disk continuously**
— never hold the only copy in your context window.

1. **At the start of the session**, create a transcript file before asking the first
   question. Use a stable, descriptive path in the current working directory:

   `grill-me/<topic-slug>-<YYYY-MM-DD>.md`

   Seed it with a header:

   ```markdown
   # Grill-Me Session: <topic>
   - Started: <date/time>
   - Status: in-progress

   ## Open threads / decision tree
   - (running list of branches still to resolve)

   ## Q&A Log
   ```

2. **After EVERY question-and-answer exchange**, immediately append the exchange to
   the file before asking the next question. Use this format:

   ```markdown
   ### Q<n>: <the question>
   - **Branch:** <which part of the decision tree this resolves>
   - **My recommendation:** <your recommended answer>
   - **User's answer:** <their actual answer>
   - **Resolved decision:** <the conclusion this locks in>
   - **New threads opened:** <any follow-up branches this created>
   ```

   Use the Edit/Write tools to append — do not batch. The whole point is that if the
   session dies after Q7, Q1–Q7 are already safely on disk.

3. **Keep the "Open threads / decision tree" section current.** Each time an answer
   opens new branches or closes existing ones, update that section so the file always
   reflects what is still unresolved. This is your durable working memory.

4. **At the end (or if the user stops early)**, append a `## Summary of Decisions`
   section consolidating every resolved decision and any remaining open questions,
   then set `Status:` to `complete` (or `paused`).

5. **Resuming:** if a `grill-me/` transcript for this topic already exists, read it
   first, summarize where things stand, and continue from the first unresolved branch
   instead of starting over.

Adapted from the grill-me skill by Matt Pocock (github.com/mattpocock/skills),
extended with continuous transcript persistence.
