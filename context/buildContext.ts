import context from "./context.json";

type BuildContextOptions = {
  userMessage: string;
  activeProjectHint?: string | null;
};

function includesAny(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function formatList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatProject(project: any) {
  return [
    `Project: ${project.name}`,
    `Description: ${project.description}`,
    `Tech stack: ${project.tech_stack}`,
    `Status: ${project.status}`,
    `Current focus: ${project.current_focus}`,
    `Codebase note: ${project.codebase_hint}`
  ].join("\n");
}

function selectRelevantProjects(userMessage: string, activeProjectHint?: string | null) {
  const projects = context.conditional.projects;

  if (activeProjectHint) {
    return projects.filter((project: any) =>
      includesAny(activeProjectHint, [project.name, ...(project.aliases ?? [])])
    );
  }

  return projects.filter((project: any) =>
    includesAny(userMessage, [project.name, ...(project.aliases ?? [])])
  );
}

function selectRelevantPeople(userMessage: string) {
  return context.conditional.important_people.filter((person: any) =>
    includesAny(userMessage, [person.name, person.relationship, ...(person.aliases ?? [])])
  );
}

export function buildContext({ userMessage, activeProjectHint = null }: BuildContextOptions) {
  const sections: string[] = [];

  const always = context.always;
  const conditional = context.conditional;

  sections.push(`BASE USER CONTEXT:
Name: ${always.identity.name}
Role: ${always.identity.role}
Location: ${always.identity.location}
Primary focus: ${always.identity.primary_focus}

Response preferences:
- Style: ${always.preferences.response_style}
- Detail level: ${always.preferences.detail_level}
- Tone: ${always.preferences.tone}

Work style:
- Coding style: ${always.work_style.coding_style}
- Learning style: ${always.work_style.learning_style}
- Decision style: ${always.work_style.decision_style}

Core constraints:
- Complexity: ${always.core_constraints.complexity_tolerance}
- Financial: ${always.core_constraints.financial}
- Technical: ${always.core_constraints.technical}
`);

  const relevantProjects = selectRelevantProjects(userMessage, activeProjectHint);

  if (
    relevantProjects.length > 0 ||
    includesAny(userMessage, ["project", "app", "repo", "codebase", "cursor", "claude", "github", "build", "expo", "react native"])
  ) {
    const projectsToInclude = relevantProjects.length > 0 ? relevantProjects : conditional.projects;

    sections.push(`PROJECT CONTEXT:
${projectsToInclude.map(formatProject).join("\n\n")}

Workspace rule:
${conditional.context_scope.when_editing_code}`);
  }

  if (includesAny(userMessage, ["goal", "plan", "future", "business", "money", "income", "strategy"])) {
    sections.push(`GOALS:
Short-term:
${formatList(conditional.goals.short_term)}

Long-term:
${formatList(conditional.goals.long_term)}`);
  }

  if (includesAny(userMessage, ["health", "hand", "thumb", "tired", "energy", "stress", "budget", "money", "cost", "cheap", "simple", "complex"])) {
    sections.push(`RELEVANT CONSTRAINTS:
- Time: ${conditional.constraints.time}
- Health: ${conditional.constraints.health}
- Energy: ${conditional.constraints.energy}
- Browsing policy: ${conditional.constraints.browsing_policy}`);
  }

  const relevantPeople = selectRelevantPeople(userMessage);

  if (relevantPeople.length > 0) {
    sections.push(`IMPORTANT PEOPLE:
${relevantPeople
  .map((person: any) => `- ${person.name}: ${person.relationship}. ${person.relevance}`)
  .join("\n")}`);
  }

  if (includesAny(userMessage, ["what now", "what next", "focus", "today", "current", "stuck", "problem", "progress", "active task"])) {
    sections.push(`CURRENT CONTEXT:
Active tasks:
${formatList(conditional.current_context.active_tasks)}

Recent progress:
${conditional.current_context.recent_progress}

Current problems:
${formatList(conditional.current_context.current_problems)}`);
  }

  if (includesAny(userMessage, ["values", "peace", "clarity", "lifestyle", "stress"])) {
    sections.push(`PERSONAL VALUES:
${formatList(conditional.personal_values)}`);
  }

  return sections.join("\n\n---\n\n");
}
