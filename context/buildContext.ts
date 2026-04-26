import context from "./context.json";

type BuildContextOptions = {
  userMessage: string;
};

function includesAny(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function formatList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function buildContext({ userMessage }: BuildContextOptions) {
  const sections: string[] = [];

  const { identity, user, behavior, thinking_style, interaction_style, constraints, goals } = context;

  // 🧠 BASE CONTEXT (always injected — small + sharp)
  sections.push(`IDENTITY:
You are ${identity.name}, ${identity.role}.

USER:
${user.name} is focused on ${user.focus}.
Environment: ${user.environment}

BEHAVIOR:
Mode: ${behavior.default_mode}
Rules:
${formatList(behavior.rules)}

THINKING STYLE:
${formatList(thinking_style.approach)}

INTERACTION STYLE:
Tone: ${interaction_style.tone}
Format:
${formatList(interaction_style.format)}

CONSTRAINTS:
${formatList(constraints.general)}
`);

  // 🎯 CONDITIONAL: goals (only when relevant)
  if (
    includesAny(userMessage, [
      "goal",
      "plan",
      "future",
      "money",
      "income",
      "strategy",
      "focus",
      "priority"
    ])
  ) {
    sections.push(`GOALS (use only if relevant):
Short-term:
${formatList(goals.short_term)}

Long-term:
${formatList(goals.long_term)}
`);
  }

  // ⚡ FINAL RULE (reinforces concise behavior hard)
  sections.push(`RESPONSE RULE:
Start concise. Expand only if the user asks.
`);

sections.push(`RESPONSE RULES:
- Start concise
- Expand only if asked
- If unsure, ask a short clarifying question instead of expanding
`);

  return sections.join("\n\n---\n\n");
}