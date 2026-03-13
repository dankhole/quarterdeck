> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> A simple, open format for giving agents new capabilities and expertise.

export const LogoCarousel = () => {
  const logos = [{
    name: "Junie",
    url: "https://junie.jetbrains.com/",
    lightSrc: "/images/logos/junie/junie-logo-on-white.svg",
    darkSrc: "/images/logos/junie/junie-logo-on-dark.svg",
    instructionsUrl: "https://junie.jetbrains.com/docs/agent-skills.html"
  }, {
    name: "Gemini CLI",
    url: "https://geminicli.com",
    lightSrc: "/images/logos/gemini-cli/gemini-cli-logo_light.svg",
    darkSrc: "/images/logos/gemini-cli/gemini-cli-logo_dark.svg",
    instructionsUrl: "https://geminicli.com/docs/cli/skills/",
    sourceCodeUrl: "https://github.com/google-gemini/gemini-cli"
  }, {
    name: "Autohand Code CLI",
    url: "https://autohand.ai/",
    lightSrc: "/images/logos/autohand/autohand-light.svg",
    darkSrc: "/images/logos/autohand/autohand-dark.svg",
    width: "120px",
    instructionsUrl: "https://autohand.ai/docs/working-with-autohand-code/agent-skills.html",
    sourceCodeUrl: "https://github.com/autohandai/code-cli"
  }, {
    name: "OpenCode",
    url: "https://opencode.ai/",
    lightSrc: "/images/logos/opencode/opencode-wordmark-light.svg",
    darkSrc: "/images/logos/opencode/opencode-wordmark-dark.svg",
    instructionsUrl: "https://opencode.ai/docs/skills/",
    sourceCodeUrl: "https://github.com/sst/opencode"
  }, {
    name: "OpenHands",
    url: "https://www.all-hands.dev/",
    lightSrc: "/images/logos/openhands/openhands-logo-light.svg",
    darkSrc: "/images/logos/openhands/openhands-logo-dark.svg",
    instructionsUrl: "https://docs.openhands.dev/overview/skills",
    sourceCodeUrl: "https://github.com/OpenHands/OpenHands"
  }, {
    name: "Mux",
    url: "https://mux.coder.com/",
    lightSrc: "/images/logos/mux/mux-editor-light.svg",
    darkSrc: "/images/logos/mux/mux-editor-dark.svg",
    width: "120px",
    instructionsUrl: "https://mux.coder.com/agent-skills",
    sourceCodeUrl: "https://github.com/coder/mux"
  }, {
    name: "Cursor",
    url: "https://cursor.com/",
    lightSrc: "/images/logos/cursor/LOCKUP_HORIZONTAL_2D_LIGHT.svg",
    darkSrc: "/images/logos/cursor/LOCKUP_HORIZONTAL_2D_DARK.svg",
    instructionsUrl: "https://cursor.com/docs/context/skills"
  }, {
    name: "Amp",
    url: "https://ampcode.com/",
    lightSrc: "/images/logos/amp/amp-logo-light.svg",
    darkSrc: "/images/logos/amp/amp-logo-dark.svg",
    width: "120px",
    instructionsUrl: "https://ampcode.com/manual#agent-skills"
  }, {
    name: "Letta",
    url: "https://www.letta.com/",
    lightSrc: "/images/logos/letta/Letta-logo-RGB_OffBlackonTransparent.svg",
    darkSrc: "/images/logos/letta/Letta-logo-RGB_GreyonTransparent.svg",
    instructionsUrl: "https://docs.letta.com/letta-code/skills/",
    sourceCodeUrl: "https://github.com/letta-ai/letta"
  }, {
    name: "Firebender",
    url: "https://firebender.com/",
    lightSrc: "/images/logos/firebender/firebender-wordmark-light.svg",
    darkSrc: "/images/logos/firebender/firebender-wordmark-dark.svg",
    instructionsUrl: "https://docs.firebender.com/multi-agent/skills"
  }, {
    name: "Goose",
    url: "https://block.github.io/goose/",
    lightSrc: "/images/logos/goose/goose-logo-black.png",
    darkSrc: "/images/logos/goose/goose-logo-white.png",
    instructionsUrl: "https://block.github.io/goose/docs/guides/context-engineering/using-skills/",
    sourceCodeUrl: "https://github.com/block/goose"
  }, {
    name: "GitHub",
    url: "https://github.com/",
    lightSrc: "/images/logos/github/GitHub_Lockup_Dark.svg",
    darkSrc: "/images/logos/github/GitHub_Lockup_Light.svg",
    instructionsUrl: "https://docs.github.com/en/copilot/concepts/agents/about-agent-skills",
    sourceCodeUrl: "https://github.com/microsoft/vscode-copilot-chat"
  }, {
    name: "VS Code",
    url: "https://code.visualstudio.com/",
    lightSrc: "/images/logos/vscode/vscode.svg",
    darkSrc: "/images/logos/vscode/vscode-alt.svg",
    instructionsUrl: "https://code.visualstudio.com/docs/copilot/customization/agent-skills",
    sourceCodeUrl: "https://github.com/microsoft/vscode"
  }, {
    name: "Claude Code",
    url: "https://claude.ai/code",
    lightSrc: "/images/logos/claude-code/Claude-Code-logo-Slate.svg",
    darkSrc: "/images/logos/claude-code/Claude-Code-logo-Ivory.svg",
    instructionsUrl: "https://code.claude.com/docs/en/skills"
  }, {
    name: "Claude",
    url: "https://claude.ai/",
    lightSrc: "/images/logos/claude-ai/Claude-logo-Slate.svg",
    darkSrc: "/images/logos/claude-ai/Claude-logo-Ivory.svg",
    instructionsUrl: "https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview"
  }, {
    name: "OpenAI Codex",
    url: "https://developers.openai.com/codex",
    lightSrc: "/images/logos/oai-codex/OAI_Codex-Lockup_400px.svg",
    darkSrc: "/images/logos/oai-codex/OAI_Codex-Lockup_400px_Darkmode.svg",
    instructionsUrl: "https://developers.openai.com/codex/skills/",
    sourceCodeUrl: "https://github.com/openai/codex"
  }, {
    name: "Piebald",
    url: "https://piebald.ai",
    lightSrc: "/images/logos/piebald/Piebald_wordmark_light.svg",
    darkSrc: "/images/logos/piebald/Piebald_wordmark_dark.svg"
  }, {
    name: "Factory",
    url: "https://factory.ai/",
    lightSrc: "/images/logos/factory/factory-logo-light.svg",
    darkSrc: "/images/logos/factory/factory-logo-dark.svg",
    instructionsUrl: "https://docs.factory.ai/cli/configuration/skills.md"
  }, {
    name: "pi",
    url: "https://shittycodingagent.ai/",
    lightSrc: "/images/logos/pi/pi-logo-light.svg",
    darkSrc: "/images/logos/pi/pi-logo-dark.svg",
    width: "80px",
    instructionsUrl: "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md",
    sourceCodeUrl: "https://github.com/badlogic/pi-mono"
  }, {
    name: "Databricks",
    url: "https://databricks.com/",
    lightSrc: "/images/logos/databricks/databricks-logo-light.svg",
    darkSrc: "/images/logos/databricks/databricks-logo-dark.svg",
    instructionsUrl: "https://docs.databricks.com/aws/en/assistant/skills"
  }, {
    name: "Agentman",
    url: "https://agentman.ai/",
    lightSrc: "/images/logos/agentman/agentman-wordmark-light.svg",
    darkSrc: "/images/logos/agentman/agentman-wordmark-dark.svg",
    instructionsUrl: "https://agentman.ai/agentskills"
  }, {
    name: "TRAE",
    url: "https://trae.ai/",
    lightSrc: "/images/logos/trae/trae-logo-lightmode.svg",
    darkSrc: "/images/logos/trae/trae-logo-darkmode.svg",
    instructionsUrl: "https://www.trae.ai/blog/trae_tutorial_0115",
    sourceCodeUrl: "https://github.com/bytedance/trae-agent"
  }, {
    name: "Spring AI",
    url: "https://docs.spring.io/spring-ai/reference",
    lightSrc: "/images/logos/spring-ai/spring-ai-logo-light.svg",
    darkSrc: "/images/logos/spring-ai/spring-ai-logo-dark.svg",
    instructionsUrl: "https://spring.io/blog/2026/01/13/spring-ai-generic-agent-skills/",
    sourceCodeUrl: "https://github.com/spring-projects/spring-ai"
  }, {
    name: "Roo Code",
    url: "https://roocode.com",
    lightSrc: "/images/logos/roo-code/roo-code-logo-black.svg",
    darkSrc: "/images/logos/roo-code/roo-code-logo-white.svg",
    instructionsUrl: "https://docs.roocode.com/features/skills",
    sourceCodeUrl: "https://github.com/RooCodeInc/Roo-Code"
  }, {
    name: "Mistral AI Vibe",
    url: "https://github.com/mistralai/mistral-vibe",
    lightSrc: "/images/logos/mistral-vibe/vibe-logo_black.svg",
    darkSrc: "/images/logos/mistral-vibe/vibe-logo_white.svg",
    width: "80px",
    instructionsUrl: "https://github.com/mistralai/mistral-vibe",
    sourceCodeUrl: "https://github.com/mistralai/mistral-vibe"
  }, {
    name: "Command Code",
    url: "https://commandcode.ai/",
    lightSrc: "/images/logos/command-code/command-code-logo-for-light.svg",
    darkSrc: "/images/logos/command-code/command-code-logo-for-dark.svg",
    width: "200px",
    instructionsUrl: "https://commandcode.ai/docs/skills"
  }, {
    name: "Ona",
    url: "https://ona.com",
    lightSrc: "/images/logos/ona/ona-wordmark-light.svg",
    darkSrc: "/images/logos/ona/ona-wordmark-dark.svg",
    width: "120px",
    instructionsUrl: "https://ona.com/docs/ona/agents-md#skills-for-repository-specific-workflows"
  }, {
    name: "VT Code",
    url: "https://github.com/vinhnx/vtcode",
    lightSrc: "/images/logos/vtcode/vt_code_light.svg",
    darkSrc: "/images/logos/vtcode/vt_code_dark.svg",
    instructionsUrl: "https://github.com/vinhnx/vtcode/blob/main/docs/skills/SKILLS_GUIDE.md",
    sourceCodeUrl: "https://github.com/vinhnx/VTCode"
  }, {
    name: "Qodo",
    url: "https://www.qodo.ai/",
    lightSrc: "/images/logos/qodo/qodo-logo-light.png",
    darkSrc: "/images/logos/qodo/qodo-logo-dark.svg",
    instructionsUrl: "https://www.qodo.ai/blog/how-i-use-qodos-agent-skills-to-auto-fix-issues-in-pull-requests/"
  }, {
    name: "Laravel Boost",
    url: "https://github.com/laravel/boost",
    lightSrc: "/images/logos/laravel-boost/boost-light-mode.svg",
    darkSrc: "/images/logos/laravel-boost/boost-dark-mode.svg",
    instructionsUrl: "https://laravel.com/docs/12.x/boost#agent-skills",
    sourceCodeUrl: "https://github.com/laravel/boost"
  }, {
    name: "Emdash",
    url: "https://emdash.sh",
    lightSrc: "/images/logos/emdash/emdash-logo-light.svg",
    darkSrc: "/images/logos/emdash/emdash-logo-dark.svg",
    instructionsUrl: "https://docs.emdash.sh/skills",
    sourceCodeUrl: "https://github.com/generalaction/emdash"
  }, {
    name: "Snowflake",
    url: "https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code",
    lightSrc: "/images/logos/snowflake/snowflake-logo-light.svg",
    darkSrc: "/images/logos/snowflake/snowflake-logo-dark.svg",
    instructionsUrl: "https://docs.snowflake.com/en/user-guide/cortex-code/extensibility#extensibility-skills"
  }];
  const [shuffled, setShuffled] = useState(logos);
  useEffect(() => {
    const shuffle = items => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };
    setShuffled(shuffle(logos));
  }, []);
  const row1 = shuffled.filter((_, i) => i % 2 === 0);
  const row2 = shuffled.filter((_, i) => i % 2 === 1);
  const row1Doubled = [...row1, ...row1];
  const row2Doubled = [...row2, ...row2];
  return <>
      <div className="logo-carousel">
        <div className="logo-carousel-track" style={{
    animation: 'logo-scroll 50s linear infinite'
  }}>
          {row1Doubled.map((logo, i) => <a key={`${logo.name}-${i}`} href={logo.url} style={{
    textDecoration: 'none',
    border: 'none'
  }}>
              <img className="block dark:hidden object-contain" style={{
    width: logo.width || '150px',
    maxWidth: '100%'
  }} src={logo.lightSrc} alt={logo.name} />
              <img className="hidden dark:block object-contain" style={{
    width: logo.width || '150px',
    maxWidth: '100%'
  }} src={logo.darkSrc} alt={logo.name} />
            </a>)}
        </div>
      </div>
      <div className="logo-carousel">
        <div className="logo-carousel-track" style={{
    animation: 'logo-scroll 60s linear infinite reverse'
  }}>
          {row2Doubled.map((logo, i) => <a key={`${logo.name}-${i}`} href={logo.url} style={{
    textDecoration: 'none',
    border: 'none'
  }}>
              <img className="block dark:hidden object-contain" style={{
    width: logo.width || '150px',
    maxWidth: '100%'
  }} src={logo.lightSrc} alt={logo.name} />
              <img className="hidden dark:block object-contain" style={{
    width: logo.width || '150px',
    maxWidth: '100%'
  }} src={logo.darkSrc} alt={logo.name} />
            </a>)}
        </div>
      </div>
    </>;
};

Agent Skills are folders of instructions, scripts, and resources that agents can discover and use to do things more accurately and efficiently.

## Why Agent Skills?

Agents are increasingly capable, but often don't have the context they need to do real work reliably. Skills solve this by giving agents access to procedural knowledge and company-, team-, and user-specific context they can load on demand. Agents with access to a set of skills can extend their capabilities based on the task they're working on.

**For skill authors**: Build capabilities once and deploy them across multiple agent products.

**For compatible agents**: Support for skills lets end users give agents new capabilities out of the box.

**For teams and enterprises**: Capture organizational knowledge in portable, version-controlled packages.

## What can Agent Skills enable?

* **Domain expertise**: Package specialized knowledge into reusable instructions, from legal review processes to data analysis pipelines.
* **New capabilities**: Give agents new capabilities (e.g. creating presentations, building MCP servers, analyzing datasets).
* **Repeatable workflows**: Turn multi-step tasks into consistent and auditable workflows.
* **Interoperability**: Reuse the same skill across different skills-compatible agent products.

## Adoption

Agent Skills are supported by leading AI development tools.

<LogoCarousel />

## Open development

The Agent Skills format was originally developed by [Anthropic](https://www.anthropic.com/), released as an open standard, and has been adopted by a growing number of agent products. The standard is open to contributions from the broader ecosystem.

[View on GitHub](https://github.com/agentskills/agentskills)

## Get started

<CardGroup cols={3}>
  <Card title="What are skills?" icon="lightbulb" href="/what-are-skills">
    Learn about skills, how they work, and why they matter.
  </Card>

  <Card title="Specification" icon="file-code" href="/specification">
    The complete format specification for SKILL.md files.
  </Card>

  <Card title="Add skills support" icon="gear" href="/client-implementation/adding-skills-support">
    Add skills support to your agent or tool.
  </Card>

  <Card title="Example skills" icon="code" href="https://github.com/anthropics/skills">
    Browse example skills on GitHub.
  </Card>

  <Card title="Reference library" icon="wrench" href="https://github.com/agentskills/agentskills/tree/main/skills-ref">
    Validate skills and generate prompt XML.
  </Card>
</CardGroup>


Built with [Mintlify](https://mintlify.com).

> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# What are skills?

> Agent Skills are a lightweight, open format for extending AI agent capabilities with specialized knowledge and workflows.

At its core, a skill is a folder containing a `SKILL.md` file. This file includes metadata (`name` and `description`, at minimum) and instructions that tell an agent how to perform a specific task. Skills can also bundle scripts, templates, and reference materials.

```directory  theme={null}
my-skill/
├── SKILL.md          # Required: instructions + metadata
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, resources
```

## How skills work

Skills use **progressive disclosure** to manage context efficiently:

1. **Discovery**: At startup, agents load only the name and description of each available skill, just enough to know when it might be relevant.

2. **Activation**: When a task matches a skill's description, the agent reads the full `SKILL.md` instructions into context.

3. **Execution**: The agent follows the instructions, optionally loading referenced files or executing bundled code as needed.

This approach keeps agents fast while giving them access to more context on demand.

## The SKILL.md file

Every skill starts with a `SKILL.md` file containing YAML frontmatter and Markdown instructions:

```mdx  theme={null}
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
---

# PDF Processing

## When to use this skill
Use this skill when the user needs to work with PDF files...

## How to extract text
1. Use pdfplumber for text extraction...

## How to fill forms
...
```

The following frontmatter is required at the top of `SKILL.md`:

* `name`: A short identifier
* `description`: When to use this skill

The Markdown body contains the actual instructions and has no specific restrictions on structure or content.

This simple format has some key advantages:

* **Self-documenting**: A skill author or user can read a `SKILL.md` and understand what it does, making skills easy to audit and improve.

* **Extensible**: Skills can range in complexity from just text instructions to executable code, assets, and templates.

* **Portable**: Skills are just files, so they're easy to edit, version, and share.

## Next steps

* [View the specification](/specification) to understand the full format.
* [Add skills support to your agent](/client-implementation/adding-skills-support) to build a compatible client.
* [See example skills](https://github.com/anthropics/skills) on GitHub.
* [Read authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) for writing effective skills.
* [Use the reference library](https://github.com/agentskills/agentskills/tree/main/skills-ref) to validate skills and generate prompt XML.


Built with [Mintlify](https://mintlify.com).

> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Specification

> The complete format specification for Agent Skills.

## Directory structure

A skill is a directory containing, at minimum, a `SKILL.md` file:

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

## `SKILL.md` format

The `SKILL.md` file must contain YAML frontmatter followed by Markdown content.

### Frontmatter

| Field           | Required | Constraints                                                                                                       |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen.             |
| `description`   | Yes      | Max 1024 characters. Non-empty. Describes what the skill does and when to use it.                                 |
| `license`       | No       | License name or reference to a bundled license file.                                                              |
| `compatibility` | No       | Max 500 characters. Indicates environment requirements (intended product, system packages, network access, etc.). |
| `metadata`      | No       | Arbitrary key-value mapping for additional metadata.                                                              |
| `allowed-tools` | No       | Space-delimited list of pre-approved tools the skill may use. (Experimental)                                      |

<Card>
  **Minimal example:**

  ```markdown SKILL.md theme={null}
  ---
  name: skill-name
  description: A description of what this skill does and when to use it.
  ---
  ```

  **Example with optional fields:**

  ```markdown SKILL.md theme={null}
  ---
  name: pdf-processing
  description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
  license: Apache-2.0
  metadata:
    author: example-org
    version: "1.0"
  ---
  ```
</Card>

#### `name` field

The required `name` field:

* Must be 1-64 characters
* May only contain unicode lowercase alphanumeric characters (`a-z`) and hyphens (`-`)
* Must not start or end with a hyphen (`-`)
* Must not contain consecutive hyphens (`--`)
* Must match the parent directory name

<Card>
  **Valid examples:**

  ```yaml  theme={null}
  name: pdf-processing
  ```

  ```yaml  theme={null}
  name: data-analysis
  ```

  ```yaml  theme={null}
  name: code-review
  ```

  **Invalid examples:**

  ```yaml  theme={null}
  name: PDF-Processing  # uppercase not allowed
  ```

  ```yaml  theme={null}
  name: -pdf  # cannot start with hyphen
  ```

  ```yaml  theme={null}
  name: pdf--processing  # consecutive hyphens not allowed
  ```
</Card>

#### `description` field

The required `description` field:

* Must be 1-1024 characters
* Should describe both what the skill does and when to use it
* Should include specific keywords that help agents identify relevant tasks

<Card>
  **Good example:**

  ```yaml  theme={null}
  description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.
  ```

  **Poor example:**

  ```yaml  theme={null}
  description: Helps with PDFs.
  ```
</Card>

#### `license` field

The optional `license` field:

* Specifies the license applied to the skill
* We recommend keeping it short (either the name of a license or the name of a bundled license file)

<Card>
  **Example:**

  ```yaml  theme={null}
  license: Proprietary. LICENSE.txt has complete terms
  ```
</Card>

#### `compatibility` field

The optional `compatibility` field:

* Must be 1-500 characters if provided
* Should only be included if your skill has specific environment requirements
* Can indicate intended product, required system packages, network access needs, etc.

<Card>
  **Examples:**

  ```yaml  theme={null}
  compatibility: Designed for Claude Code (or similar products)
  ```

  ```yaml  theme={null}
  compatibility: Requires git, docker, jq, and access to the internet
  ```
</Card>

<Note>
  Most skills do not need the `compatibility` field.
</Note>

#### `metadata` field

The optional `metadata` field:

* A map from string keys to string values
* Clients can use this to store additional properties not defined by the Agent Skills spec
* We recommend making your key names reasonably unique to avoid accidental conflicts

<Card>
  **Example:**

  ```yaml  theme={null}
  metadata:
    author: example-org
    version: "1.0"
  ```
</Card>

#### `allowed-tools` field

The optional `allowed-tools` field:

* A space-delimited list of tools that are pre-approved to run
* Experimental. Support for this field may vary between agent implementations

<Card>
  **Example:**

  ```yaml  theme={null}
  allowed-tools: Bash(git:*) Bash(jq:*) Read
  ```
</Card>

### Body content

The Markdown body after the frontmatter contains the skill instructions. There are no format restrictions. Write whatever helps agents perform the task effectively.

Recommended sections:

* Step-by-step instructions
* Examples of inputs and outputs
* Common edge cases

Note that the agent will load this entire file once it's decided to activate a skill. Consider splitting longer `SKILL.md` content into referenced files.

## Optional directories

### `scripts/`

Contains executable code that agents can run. Scripts should:

* Be self-contained or clearly document dependencies
* Include helpful error messages
* Handle edge cases gracefully

Supported languages depend on the agent implementation. Common options include Python, Bash, and JavaScript.

### `references/`

Contains additional documentation that agents can read when needed:

* `REFERENCE.md` - Detailed technical reference
* `FORMS.md` - Form templates or structured data formats
* Domain-specific files (`finance.md`, `legal.md`, etc.)

Keep individual [reference files](#file-references) focused. Agents load these on demand, so smaller files mean less use of context.

### `assets/`

Contains static resources:

* Templates (document templates, configuration templates)
* Images (diagrams, examples)
* Data files (lookup tables, schemas)

## Progressive disclosure

Skills should be structured for efficient use of context:

1. **Metadata** (\~100 tokens): The `name` and `description` fields are loaded at startup for all skills
2. **Instructions** (\< 5000 tokens recommended): The full `SKILL.md` body is loaded when the skill is activated
3. **Resources** (as needed): Files (e.g. those in `scripts/`, `references/`, or `assets/`) are loaded only when required

Keep your main `SKILL.md` under 500 lines. Move detailed reference material to separate files.

## File references

When referencing other files in your skill, use relative paths from the skill root:

```markdown SKILL.md theme={null}
See [the reference guide](references/REFERENCE.md) for details.

Run the extraction script:
scripts/extract.py
```

Keep file references one level deep from `SKILL.md`. Avoid deeply nested reference chains.

## Validation

Use the [skills-ref](https://github.com/agentskills/agentskills/tree/main/skills-ref) reference library to validate your skills:

```bash  theme={null}
skills-ref validate ./my-skill
```

This checks that your `SKILL.md` frontmatter is valid and follows all naming conventions.


Built with [Mintlify](https://mintlify.com).

> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Optimizing skill descriptions

> How to improve your skill's description so it triggers reliably on relevant prompts.

A skill only helps if it gets activated. The `description` field in your `SKILL.md` frontmatter is the primary mechanism agents use to decide whether to load a skill for a given task. An under-specified description means the skill won't trigger when it should; an over-broad description means it triggers when it shouldn't.

This guide covers how to systematically test and improve your skill's description for triggering accuracy.

## How skill triggering works

Agents use [progressive disclosure](/what-are-skills#how-skills-work) to manage context. At startup, they load only the `name` and `description` of each available skill — just enough to decide when a skill might be relevant. When a user's task matches a description, the agent reads the full `SKILL.md` into context and follows its instructions.

This means the description carries the entire burden of triggering. If the description doesn't convey when the skill is useful, the agent won't know to reach for it.

One important nuance: agents typically only consult skills for tasks that require knowledge or capabilities beyond what they can handle alone. A simple, one-step request like "read this PDF" may not trigger a PDF skill even if the description matches perfectly, because the agent can handle it with basic tools. Tasks that involve specialized knowledge — an unfamiliar API, a domain-specific workflow, or an uncommon format — are where a well-written description can make the difference.

## Writing effective descriptions

Before testing, it helps to know what a good description looks like. A few principles:

* **Use imperative phrasing.** Frame the description as an instruction to the agent: "Use this skill when..." rather than "This skill does..." The agent is deciding whether to act, so tell it when to act.
* **Focus on user intent, not implementation.** Describe what the user is trying to achieve, not the skill's internal mechanics. The agent matches against what the user asked for.
* **Err on the side of being pushy.** Explicitly list contexts where the skill applies, including cases where the user doesn't name the domain directly: "even if they don't explicitly mention 'CSV' or 'analysis.'"
* **Keep it concise.** A few sentences to a short paragraph is usually right — long enough to cover the skill's scope, short enough that it doesn't bloat the agent's context across many skills. The [specification](/specification#description-field) enforces a hard limit of 1024 characters.

## Designing trigger eval queries

To test triggering, you need a set of eval queries — realistic user prompts labeled with whether they should or shouldn't trigger your skill.

```json eval_queries.json theme={null}
[
  { "query": "I've got a spreadsheet in ~/data/q4_results.xlsx with revenue in col C and expenses in col D — can you add a profit margin column and highlight anything under 10%?", "should_trigger": true },
  { "query": "whats the quickest way to convert this json file to yaml", "should_trigger": false }
]
```

Aim for about 20 queries: 8-10 that should trigger and 8-10 that shouldn't.

### Should-trigger queries

These test whether the description captures the skill's scope. Vary them along several axes:

* **Phrasing**: some formal, some casual, some with typos or abbreviations.
* **Explicitness**: some name the skill's domain directly ("analyze this CSV"), others describe the need without naming it ("my boss wants a chart from this data file").
* **Detail**: mix terse prompts with context-heavy ones — a short "analyze my sales CSV and make a chart" alongside a longer message with file paths, column names, and backstory.
* **Complexity**: vary the number of steps and decision points. Include single-step tasks alongside multi-step workflows to test whether the agent can discern the skill is relevant when the task it addresses is buried in a larger chain.

The most useful should-trigger queries are ones where the skill would help but the connection isn't obvious from the query alone. These are the cases where description wording makes the difference — if the query already asks for exactly what the skill does, any reasonable description would trigger.

### Should-not-trigger queries

The most valuable negative test cases are **near-misses** — queries that share keywords or concepts with your skill but actually need something different. These test whether the description is precise, not just broad.

For a CSV analysis skill, weak negative examples would be:

* `"Write a fibonacci function"` — obviously irrelevant, tests nothing.
* `"What's the weather today?"` — no keyword overlap, too easy.

Strong negative examples:

* `"I need to update the formulas in my Excel budget spreadsheet"` — shares "spreadsheet" and "data" concepts, but needs Excel editing, not CSV analysis.
* `"can you write a python script that reads a csv and uploads each row to our postgres database"` — involves CSV, but the task is database ETL, not analysis.

### Tips for realism

Real user prompts contain context that generic test queries lack. Include:

* File paths (`~/Downloads/report_final_v2.xlsx`)
* Personal context (`"my manager asked me to..."`)
* Specific details (column names, company names, data values)
* Casual language, abbreviations, and occasional typos

## Testing whether a description triggers

The basic approach: run each query through your agent with the skill installed and observe whether the agent invokes it. Make sure the skill is registered and discoverable by your agent — how this works varies by client (e.g., a skills directory, a configuration file, or a CLI flag).

Most agent clients provide some form of observability — execution logs, tool call histories, or verbose output — that lets you see which skills were consulted during a run. Check your client's documentation for details. The skill triggered if the agent loaded your skill's `SKILL.md`; it didn't trigger if the agent proceeded without consulting it.

A query "passes" if:

* `should_trigger` is `true` and the skill was invoked, or
* `should_trigger` is `false` and the skill was not invoked.

### Running multiple times

Model behavior is nondeterministic — the same query might trigger the skill on one run but not the next. Run each query multiple times (3 is a reasonable starting point) and compute a **trigger rate**: the fraction of runs where the skill was invoked.

A should-trigger query passes if its trigger rate is above a threshold (0.5 is a reasonable default). A should-not-trigger query passes if its trigger rate is below that threshold.

With 20 queries at 3 runs each, that's 60 invocations. You'll want to script this. Here's the general structure — replace the `claude` invocation and detection logic in `check_triggered` with whatever your agent client provides:

```bash  theme={null}
#!/bin/bash
QUERIES_FILE="${1:?Usage: $0 <queries.json>}"
SKILL_NAME="my-skill"
RUNS=3

# This example uses Claude Code's JSON output to check for Skill tool calls.
# Replace this function with detection logic for your agent client.
# Should return 0 (success) if the skill was invoked, 1 otherwise.
check_triggered() {
  local query="$1"
  claude -p "$query" --output-format json 2>/dev/null \
    | jq -e --arg skill "$SKILL_NAME" \
      'any(.messages[].content[]; .type == "tool_use" and .name == "Skill" and .input.skill == $skill)' \
      > /dev/null 2>&1
}

count=$(jq length "$QUERIES_FILE")
for i in $(seq 0 $((count - 1))); do
  query=$(jq -r ".[$i].query" "$QUERIES_FILE")
  should_trigger=$(jq -r ".[$i].should_trigger" "$QUERIES_FILE")
  triggers=0

  for run in $(seq 1 $RUNS); do
    check_triggered "$query" && triggers=$((triggers + 1))
  done

  jq -n \
    --arg query "$query" \
    --argjson should_trigger "$should_trigger" \
    --argjson triggers "$triggers" \
    --argjson runs "$RUNS" \
    '{query: $query, should_trigger: $should_trigger, triggers: $triggers, runs: $runs, trigger_rate: ($triggers / $runs)}'
done | jq -s '.'
```

<Tip>
  If your agent client supports it, you can stop a run early once the outcome is clear — the agent either consulted the skill or started working without it. This can significantly reduce the time and cost of running the full eval set.
</Tip>

## Avoiding overfitting with train/validation splits

If you optimize the description against all your queries, you risk overfitting — crafting a description that works for these specific phrasings but fails on new ones.

The solution is to split your query set:

* **Train set (\~60%)**: the queries you use to identify failures and guide improvements.
* **Validation set (\~40%)**: queries you set aside and only use to check whether improvements generalize.

Make sure both sets contain a proportional mix of should-trigger and should-not-trigger queries — don't accidentally put all the positives in one set. Shuffle randomly and keep the split fixed across iterations so you're comparing apples to apples.

If you're using a script like the one [above](#running-multiple-times), you can split your queries into two files — `train_queries.json` and `validation_queries.json` — and run the script against each one separately.

## The optimization loop

1. **Evaluate** the current description on both *train and validation sets*. The train results guide your changes; the validation results tell you whether those changes are generalizing.
2. **Identify failures** in the *train set*: which should-trigger queries didn't trigger? Which should-not-trigger queries did?
   * Only use train set failures to guide your changes — whether you're revising the description yourself or prompting an LLM, keep validation set results out of the process.
3. **Revise the description.** Focus on generalizing:
   * If should-trigger queries are failing, the description may be too narrow. Broaden the scope or add context about when the skill is useful.
   * If should-not-trigger queries are false-triggering, the description may be too broad. Add specificity about what the skill does *not* do, or clarify the boundary between this skill and adjacent capabilities.
   * Avoid adding specific keywords from failed queries — that's overfitting. Instead, find the general category or concept those queries represent and address that.
   * If you're stuck after several iterations, try a structurally different approach to the description rather than incremental tweaks. A different framing or sentence structure may break through where refinement can't.
   * Check that the description stays under the 1024-character limit — descriptions tend to grow during optimization.
4. **Repeat** steps 1-3 until all *train set* queries pass or you stop seeing meaningful improvement.
5. **Select the best iteration** by its validation pass rate — the fraction of queries in the *validation set* that passed. Note that the best description may not be the last one you produced; an earlier iteration might have a higher validation pass rate than later ones that overfit to the train set.

Five iterations is usually enough. If performance isn't improving, the issue may be with the queries (too easy, too hard, or poorly labeled) rather than the description.

<Tip>
  The [`skill-creator`](https://github.com/anthropics/skills/tree/main/skills/skill-creator) Skill automates this loop end-to-end: it splits the eval set, evaluates trigger rates in parallel, proposes description improvements using Claude, and generates a live HTML report you can watch as it runs.
</Tip>

## Applying the result

Once you've selected the best description:

1. Update the `description` field in your `SKILL.md` frontmatter.
2. Verify the description is under the [1024-character limit](/specification#description-field).
3. Verify the description triggers as expected. Try a few prompts manually as a quick sanity check. For a more rigorous test, write 5-10 fresh queries (a mix of should-trigger and should-not-trigger) and run them through the eval script — since these queries were never part of the optimization process, they give you an honest check on whether the description generalizes.

Before and after:

```yaml  theme={null}
# Before
description: Process CSV files.

# After
description: >
  Analyze CSV and tabular data files — compute summary statistics,
  add derived columns, generate charts, and clean messy data. Use this
  skill when the user has a CSV, TSV, or Excel file and wants to
  explore, transform, or visualize the data, even if they don't
  explicitly mention "CSV" or "analysis."
```

The improved description is more specific about what the skill does (summary stats, derived columns, charts, cleaning) and broader about when it applies (CSV, TSV, Excel; even without explicit keywords).

## Next steps

Once your skill triggers reliably, you'll want to evaluate whether it produces good outputs. See [Evaluating skill output quality](/skill-creation/evaluating-skills) for how to set up test cases, grade results, and iterate.


Built with [Mintlify](https://mintlify.com).

> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Using scripts in skills

> How to run commands and bundle executable scripts in your skills.

Skills can instruct agents to run shell commands and bundle reusable scripts in a `scripts/` directory. This guide covers one-off commands, self-contained scripts with their own dependencies, and how to design script interfaces for agentic use.

## One-off commands

When an existing package already does what you need, you can reference it directly in your `SKILL.md` instructions without a `scripts/` directory. Many ecosystems provide tools that auto-resolve dependencies at runtime.

<Tabs sync={false}>
  <Tab title="uvx">
    [uvx](https://docs.astral.sh/uv/guides/tools/) runs Python packages in isolated environments with aggressive caching. It ships with [uv](https://docs.astral.sh/uv/).

    ```bash  theme={null}
    uvx ruff@0.8.0 check .
    uvx black@24.10.0 .
    ```

    * Not bundled with Python — requires a separate install.
    * Fast. Caches aggressively so repeat runs are near-instant.
  </Tab>

  <Tab title="pipx">
    [pipx](https://pipx.pypa.io/) runs Python packages in isolated environments. Available via OS package managers (`apt install pipx`, `brew install pipx`).

    ```bash  theme={null}
    pipx run 'black==24.10.0' .
    pipx run 'ruff==0.8.0' check .
    ```

    * Not bundled with Python — requires a separate install.
    * A mature alternative to `uvx`. While `uvx` has become the standard recommendation, `pipx` remains a reliable option with broader OS package manager availability.
  </Tab>

  <Tab title="npx">
    [npx](https://docs.npmjs.com/cli/commands/npx) runs npm packages, downloading them on demand. It ships with npm (which ships with Node.js).

    ```bash  theme={null}
    npx eslint@9 --fix .
    npx create-vite@6 my-app
    ```

    * Bundled with Node.js — no extra install needed.
    * Downloads the package, runs it, and caches it for future use.
    * Pin versions with `npx package@version` for reproducibility.
  </Tab>

  <Tab title="bunx">
    [bunx](https://bun.sh/docs/cli/bunx) is Bun's equivalent of `npx`. It ships with [Bun](https://bun.sh/).

    ```bash  theme={null}
    bunx eslint@9 --fix .
    bunx create-vite@6 my-app
    ```

    * Drop-in replacement for `npx` in Bun-based environments.
    * Only appropriate when the user's environment has Bun rather than Node.js.
  </Tab>

  <Tab title="deno run">
    [deno run](https://docs.deno.com/runtime/reference/cli/run/) runs scripts directly from URLs or specifiers. It ships with [Deno](https://deno.com/).

    ```bash  theme={null}
    deno run npm:create-vite@6 my-app
    deno run --allow-read npm:eslint@9 -- --fix .
    ```

    * Permission flags (`--allow-read`, etc.) are required for filesystem/network access.
    * Use `--` to separate Deno flags from the tool's own flags.
  </Tab>

  <Tab title="go run">
    [go run](https://pkg.go.dev/cmd/go#hdr-Compile_and_run_Go_program) compiles and runs Go packages directly. It is built into the `go` command.

    ```bash  theme={null}
    go run golang.org/x/tools/cmd/goimports@v0.28.0 .
    go run github.com/golangci/golangci-lint/cmd/golangci-lint@v1.62.0 run
    ```

    * Built into Go — no extra tooling needed.
    * Pin versions or use `@latest` to make the command explicit.
  </Tab>
</Tabs>

**Tips for one-off commands in skills:**

* **Pin versions** (e.g., `npx eslint@9.0.0`) so the command behaves the same over time.
* **State prerequisites** in your `SKILL.md` (e.g., "Requires Node.js 18+") rather than assuming the agent's environment has them. For runtime-level requirements, use the [`compatibility` frontmatter field](/specification#compatibility-field).
* **Move complex commands into scripts.** A one-off command works well when you're invoking a tool with a few flags. When a command grows complex enough that it's hard to get right on the first try, a tested script in `scripts/` is more reliable.

## Referencing scripts from `SKILL.md`

Use **relative paths from the skill directory root** to reference bundled files. The agent resolves these paths automatically — no absolute paths needed.

List available scripts in your `SKILL.md` so the agent knows they exist:

```markdown SKILL.md theme={null}
## Available scripts

- **`scripts/validate.sh`** — Validates configuration files
- **`scripts/process.py`** — Processes input data
```

Then instruct the agent to run them:

````markdown SKILL.md theme={null}
## Workflow

1. Run the validation script:
   ```bash
   bash scripts/validate.sh "$INPUT_FILE"
   ```

2. Process the results:
   ```bash
   python3 scripts/process.py --input results.json
   ```
````

<Note>
  The same relative-path convention works in support files like `references/*.md` — script execution paths (in code blocks) are relative to the **skill directory root**, because the agent runs commands from there.
</Note>

## Self-contained scripts

When you need reusable logic, bundle a script in `scripts/` that declares its own dependencies inline. The agent can run the script with a single command — no separate manifest file or install step required.

Several languages support inline dependency declarations:

<Tabs sync={false}>
  <Tab title="Python">
    [PEP 723](https://peps.python.org/pep-0723/) defines a standard format for inline script metadata. Declare dependencies in a TOML block inside `# ///` markers:

    ```python scripts/extract.py theme={null}
    # /// script
    # dependencies = [
    #   "beautifulsoup4",
    # ]
    # ///

    from bs4 import BeautifulSoup

    html = '<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>'
    print(BeautifulSoup(html, "html.parser").select_one("p.info").get_text())
    ```

    Run with [uv](https://docs.astral.sh/uv/) (recommended):

    ```bash  theme={null}
    uv run scripts/extract.py
    ```

    `uv run` creates an isolated environment, installs the declared dependencies, and runs the script. [pipx](https://pipx.pypa.io/) (`pipx run scripts/extract.py`) also supports PEP 723.

    * Pin versions with [PEP 508](https://peps.python.org/pep-0508/) specifiers: `"beautifulsoup4>=4.12,<5"`.
    * Use `requires-python` to constrain the Python version.
    * Use `uv lock --script` to create a lockfile for full reproducibility.
  </Tab>

  <Tab title="Deno">
    Deno's `npm:` and `jsr:` import specifiers make every script self-contained by default:

    ```typescript scripts/extract.ts theme={null}
    #!/usr/bin/env -S deno run

    import * as cheerio from "npm:cheerio@1.0.0";

    const html = `<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>`;
    const $ = cheerio.load(html);
    console.log($("p.info").text());
    ```

    ```bash  theme={null}
    deno run scripts/extract.ts
    ```

    * Use `npm:` for npm packages, `jsr:` for Deno-native packages.
    * Version specifiers follow semver: `@1.0.0` (exact), `@^1.0.0` (compatible).
    * Dependencies are cached globally. Use `--reload` to force re-fetch.
    * Packages with native addons (node-gyp) may not work — packages that ship pre-built binaries work best.
  </Tab>

  <Tab title="Bun">
    Bun auto-installs missing packages at runtime when no `node_modules` directory is found. Pin versions directly in the import path:

    ```typescript scripts/extract.ts theme={null}
    #!/usr/bin/env bun

    import * as cheerio from "cheerio@1.0.0";

    const html = `<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>`;
    const $ = cheerio.load(html);
    console.log($("p.info").text());
    ```

    ```bash  theme={null}
    bun run scripts/extract.ts
    ```

    * No `package.json` or `node_modules` needed. TypeScript works natively.
    * Packages are cached globally. First run downloads; subsequent runs are near-instant.
    * If a `node_modules` directory exists anywhere up the directory tree, auto-install is disabled and Bun falls back to standard Node.js resolution.
  </Tab>

  <Tab title="Ruby">
    Bundler ships with Ruby since 2.6. Use `bundler/inline` to declare gems directly in the script:

    ```ruby scripts/extract.rb theme={null}
    require 'bundler/inline'

    gemfile do
      source 'https://rubygems.org'
      gem 'nokogiri'
    end

    html = '<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>'
    doc = Nokogiri::HTML(html)
    puts doc.at_css('p.info').text
    ```

    ```bash  theme={null}
    ruby scripts/extract.rb
    ```

    * Pin versions explicitly (`gem 'nokogiri', '~> 1.16'`) — there is no lockfile.
    * An existing `Gemfile` or `BUNDLE_GEMFILE` env var in the working directory can interfere.
  </Tab>
</Tabs>

## Designing scripts for agentic use

When an agent runs your script, it reads stdout and stderr to decide what to do next. A few design choices make scripts dramatically easier for agents to use.

### Avoid interactive prompts

This is a hard requirement of the agent execution environment. Agents operate in non-interactive shells — they cannot respond to TTY prompts, password dialogs, or confirmation menus. A script that blocks on interactive input will hang indefinitely.

Accept all input via command-line flags, environment variables, or stdin:

```
# Bad: hangs waiting for input
$ python scripts/deploy.py
Target environment: _

# Good: clear error with guidance
$ python scripts/deploy.py
Error: --env is required. Options: development, staging, production.
Usage: python scripts/deploy.py --env staging --tag v1.2.3
```

### Document usage with `--help`

`--help` output is the primary way an agent learns your script's interface. Include a brief description, available flags, and usage examples:

```
Usage: scripts/process.py [OPTIONS] INPUT_FILE

Process input data and produce a summary report.

Options:
  --format FORMAT    Output format: json, csv, table (default: json)
  --output FILE      Write output to FILE instead of stdout
  --verbose          Print progress to stderr

Examples:
  scripts/process.py data.csv
  scripts/process.py --format csv --output report.csv data.csv
```

Keep it concise — the output enters the agent's context window alongside everything else it's working with.

### Write helpful error messages

When an agent gets an error, the message directly shapes its next attempt. An opaque "Error: invalid input" wastes a turn. Instead, say what went wrong, what was expected, and what to try:

```
Error: --format must be one of: json, csv, table.
       Received: "xml"
```

### Use structured output

Prefer structured formats — JSON, CSV, TSV — over free-form text. Structured formats can be consumed by both the agent and standard tools (`jq`, `cut`, `awk`), making your script composable in pipelines.

```
# Whitespace-aligned — hard to parse programmatically
NAME          STATUS    CREATED
my-service    running   2025-01-15

# Delimited — unambiguous field boundaries
{"name": "my-service", "status": "running", "created": "2025-01-15"}
```

**Separate data from diagnostics:** send structured data to stdout and progress messages, warnings, and other diagnostics to stderr. This lets the agent capture clean, parseable output while still having access to diagnostic information when needed.

### Further considerations

* **Idempotency.** Agents may retry commands. "Create if not exists" is safer than "create and fail on duplicate."
* **Input constraints.** Reject ambiguous input with a clear error rather than guessing. Use enums and closed sets where possible.
* **Dry-run support.** For destructive or stateful operations, a `--dry-run` flag lets the agent preview what will happen.
* **Meaningful exit codes.** Use distinct exit codes for different failure types (not found, invalid arguments, auth failure) and document them in your `--help` output so the agent knows what each code means.
* **Safe defaults.** Consider whether destructive operations should require explicit confirmation flags (`--confirm`, `--force`) or other safeguards appropriate to the risk level.
* **Predictable output size.** Many agent harnesses automatically truncate tool output beyond a threshold (e.g., 10-30K characters), potentially losing critical information. If your script might produce large output, default to a summary or a reasonable limit, and support flags like `--offset` so the agent can request more information when needed. Alternatively, if output is large and not amenable to pagination, require agents to pass an `--output` flag that specifies either an output file or `-` to explicitly opt in to stdout.


Built with [Mintlify](https://mintlify.com).

> ## Documentation Index
> Fetch the complete documentation index at: https://agentskills.io/llms.txt
> Use this file to discover all available pages before exploring further.

# How to add skills support to your agent

> A guide for adding Agent Skills support to an AI agent or development tool.

This guide walks through how to add Agent Skills support to an AI agent or development tool. It covers the full lifecycle: discovering skills, telling the model about them, loading their content into context, and keeping that content effective over time.

The core integration is the same regardless of your agent's architecture. The implementation details vary based on two factors:

* **Where do skills live?** A locally-running agent can scan the user's filesystem for skill directories. A cloud-hosted or sandboxed agent will need an alternative discovery mechanism — an API, a remote registry, or bundled assets.
* **How does the model access skill content?** If the model has file-reading capabilities, it can read `SKILL.md` files directly. Otherwise, you'll provide a dedicated tool or inject skill content into the prompt programmatically.

The guide notes where these differences matter. You don't need to support every scenario — follow the path that fits your agent.

**Prerequisites**: Familiarity with the [Agent Skills specification](/specification), which defines the `SKILL.md` file format, frontmatter fields, and directory conventions.

## The core principle: progressive disclosure

Every skills-compatible agent follows the same three-tier loading strategy:

| Tier            | What's loaded               | When                                 | Token cost                  |
| --------------- | --------------------------- | ------------------------------------ | --------------------------- |
| 1. Catalog      | Name + description          | Session start                        | \~50-100 tokens per skill   |
| 2. Instructions | Full `SKILL.md` body        | When the skill is activated          | \<5000 tokens (recommended) |
| 3. Resources    | Scripts, references, assets | When the instructions reference them | Varies                      |

The model sees the catalog from the start, so it knows what skills are available. When it decides a skill is relevant, it loads the full instructions. If those instructions reference supporting files, the model loads them individually as needed.

This keeps the base context small while giving the model access to specialized knowledge on demand. An agent with 20 installed skills doesn't pay the token cost of 20 full instruction sets upfront — only the ones actually used in a given conversation.

## Step 1: Discover skills

At session startup, find all available skills and load their metadata.

### Where to scan

Which directories you scan depends on your agent's environment. Most locally-running agents scan at least two scopes:

* **Project-level** (relative to the working directory): Skills specific to a project or repository.
* **User-level** (relative to the home directory): Skills available across all projects for a given user.

Other scopes are possible too — for example, organization-wide skills deployed by an admin, or skills bundled with the agent itself. The right set of scopes depends on your agent's deployment model.

Within each scope, consider scanning both a **client-specific directory** and the **`.agents/skills/` convention**:

| Scope   | Path                               | Purpose                       |
| ------- | ---------------------------------- | ----------------------------- |
| Project | `<project>/.<your-client>/skills/` | Your client's native location |
| Project | `<project>/.agents/skills/`        | Cross-client interoperability |
| User    | `~/.<your-client>/skills/`         | Your client's native location |
| User    | `~/.agents/skills/`                | Cross-client interoperability |

The `.agents/skills/` paths have emerged as a widely-adopted convention for cross-client skill sharing. While the Agent Skills specification does not mandate where skill directories live (it only defines what goes inside them), scanning `.agents/skills/` means skills installed by other compliant clients are automatically visible to yours, and vice versa.

<Note>
  Some implementations also scan `.claude/skills/` (both project-level and user-level) for pragmatic compatibility, since many existing skills are installed there. Other additional locations include ancestor directories up to the git root (useful for monorepos), [XDG](https://specifications.freedesktop.org/basedir-spec/latest/) config directories, and user-configured paths.
</Note>

### What to scan for

Within each skills directory, look for **subdirectories containing a file named exactly `SKILL.md`**:

```
~/.agents/skills/
├── pdf-processing/
│   ├── SKILL.md          ← discovered
│   └── scripts/
│       └── extract.py
├── data-analysis/
│   └── SKILL.md          ← discovered
└── README.md             ← ignored (not a skill directory)
```

Practical scanning rules:

* Skip directories that won't contain skills, such as `.git/` and `node_modules/`
* Optionally respect `.gitignore` to avoid scanning build artifacts
* Set reasonable bounds (e.g., max depth of 4-6 levels, max 2000 directories) to prevent runaway scanning in large directory trees

### Handling name collisions

When two skills share the same `name`, apply a deterministic precedence rule.

The universal convention across existing implementations: **project-level skills override user-level skills.**

Within the same scope (e.g., two skills named `code-review` found under both `<project>/.agents/skills/` and `<project>/.<your-client>/skills/`), either first-found or last-found is acceptable — pick one and be consistent. Log a warning when a collision occurs so the user knows a skill was shadowed.

### Trust considerations

Project-level skills come from the repository being worked on, which may be untrusted (e.g., a freshly cloned open-source project). Consider gating project-level skill loading on a trust check — only load them if the user has marked the project folder as trusted. This prevents untrusted repositories from silently injecting instructions into the agent's context.

### Cloud-hosted and sandboxed agents

If your agent runs in a container or on a remote server, it won't have access to the user's local filesystem. Discovery needs to work differently depending on the skill scope:

* **Project-level skills** are often the easiest case. If the agent operates on a cloned repository (even inside a sandbox), project-level skills travel with the code and can be scanned from the repo's directory tree.
* **User-level and organization-level skills** don't exist in the sandbox. You'll need to provision them from an external source — for example, cloning a configuration repository, accepting skill URLs or packages through your agent's settings, or letting users upload skill directories through a web UI.
* **Built-in skills** can be packaged as static assets within the agent's deployment artifact, making them available in every session without external fetching.

Once skills are available to the agent, the rest of the lifecycle — parsing, disclosure, activation — works the same.

## Step 2: Parse `SKILL.md` files

For each discovered `SKILL.md`, extract the metadata and body content.

### Frontmatter extraction

A `SKILL.md` file has two parts: YAML frontmatter between `---` delimiters, and a markdown body after the closing delimiter. To parse:

1. Find the opening `---` at the start of the file and the closing `---` after it.
2. Parse the YAML block between them. Extract `name` and `description` (required), plus any optional fields.
3. Everything after the closing `---`, trimmed, is the skill's body content.

See the [specification](/specification) for the full set of frontmatter fields and their constraints.

### Handling malformed YAML

Skill files authored for other clients may contain technically invalid YAML that their parsers happen to accept. The most common issue is unquoted values containing colons:

```yaml  theme={null}
# Technically invalid YAML — the colon breaks parsing
description: Use this skill when: the user asks about PDFs
```

Consider a fallback that wraps such values in quotes or converts them to YAML block scalars before retrying. This improves cross-client compatibility at minimal cost.

### Lenient validation

Warn on issues but still load the skill when possible:

* Name doesn't match the parent directory name → warn, load anyway
* Name exceeds 64 characters → warn, load anyway
* Description is missing or empty → skip the skill (a description is essential for disclosure), log the error
* YAML is completely unparseable → skip the skill, log the error

Record diagnostics so they can be surfaced to the user (in a debug command, log file, or UI), but don't block skill loading on cosmetic issues.

<Note>
  The [specification](/specification) defines strict constraints on the `name` field (matching the parent directory, character set, max length). The lenient approach above deliberately relaxes these to improve compatibility with skills authored for other clients.
</Note>

### What to store

At minimum, each skill record needs three fields:

| Field         | Description                          |
| ------------- | ------------------------------------ |
| `name`        | From frontmatter                     |
| `description` | From frontmatter                     |
| `location`    | Absolute path to the `SKILL.md` file |

Store these in an in-memory map keyed by `name` for fast lookup during activation.

You can also store the **body** (the markdown content after the frontmatter) at discovery time, or read it from `location` at activation time. Storing it makes activation faster; reading it at activation time uses less memory in aggregate and picks up changes to skill files between activations.

The skill's **base directory** (the parent directory of `location`) is needed later to resolve relative paths and enumerate bundled resources — derive it from `location` when needed.

## Step 3: Disclose available skills to the model

Tell the model what skills exist without loading their full content. This is [tier 1 of progressive disclosure](#the-core-principle-progressive-disclosure).

### Building the skill catalog

For each discovered skill, include `name`, `description`, and optionally `location` (the path to the `SKILL.md` file) in whatever structured format suits your stack — XML, JSON, or a bulleted list all work:

```xml  theme={null}
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extract PDF text, fill forms, merge files. Use when handling PDFs.</description>
    <location>/home/user/.agents/skills/pdf-processing/SKILL.md</location>
  </skill>
  <skill>
    <name>data-analysis</name>
    <description>Analyze datasets, generate charts, and create summary reports.</description>
    <location>/home/user/project/.agents/skills/data-analysis/SKILL.md</location>
  </skill>
</available_skills>
```

The `location` field serves two purposes: it enables file-read activation (see [Step 4](#step-4-activate-skills)), and it gives the model a base path for resolving relative references in the skill body (like `scripts/evaluate.py`). If your dedicated activation tool provides the skill directory path in its result (see [Structured wrapping](#structured-wrapping) in Step 4), you can omit `location` from the catalog. Otherwise, include it.

Each skill adds roughly 50-100 tokens to the catalog. Even with dozens of skills installed, the catalog remains compact.

### Where to place the catalog

Two approaches are common:

**System prompt section**: Add the catalog as a labeled section in the system prompt, preceded by brief instructions on how to use skills. This is the simplest approach and works with any model that has access to a file-reading tool.

**Tool description**: Embed the catalog in the description of a dedicated skill-activation tool (see [Step 4](#step-4-activate-skills)). This keeps the system prompt clean and naturally couples discovery with activation.

Both work. System prompt placement is simpler and more broadly compatible; tool description embedding is cleaner when you have a dedicated activation tool.

### Behavioral instructions

Include a short instruction block alongside the catalog telling the model how and when to use skills. The wording depends on which activation mechanism you support (see [Step 4](#step-4-activate-skills)):

**If the model activates skills by reading files:**

```
The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, use your file-read tool to load
the SKILL.md at the listed location before proceeding.
When a skill references relative paths, resolve them against the skill's
directory (the parent of SKILL.md) and use absolute paths in tool calls.
```

**If the model activates skills via a dedicated tool:**

```
The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call the activate_skill tool
with the skill's name to load its full instructions.
```

Keep these instructions concise. The goal is to tell the model that skills exist and how to load them — the skill content itself provides the detailed instructions once loaded.

### Filtering

Some skills should be excluded from the catalog. Common reasons:

* The user has disabled the skill in settings
* A permission system denies access to the skill
* The skill has opted out of model-driven activation (e.g., via a `disable-model-invocation` flag)

**Hide filtered skills entirely** from the catalog rather than listing them and blocking at activation time. This prevents the model from wasting turns attempting to load skills it can't use.

### When no skills are available

If no skills are discovered, omit the catalog and behavioral instructions entirely. Don't show an empty `<available_skills/>` block or register a skill tool with no valid options — this would confuse the model.

## Step 4: Activate skills

When the model or user selects a skill, deliver the full instructions into the conversation context. This is [tier 2 of progressive disclosure](#the-core-principle-progressive-disclosure).

### Model-driven activation

Most implementations rely on the model's own judgment as the activation mechanism, rather than implementing harness-side trigger matching or keyword detection. The model reads the catalog (from [Step 3](#step-3-disclose-available-skills-to-the-model)), decides a skill is relevant to the current task, and loads it.

Two implementation patterns:

**File-read activation**: The model calls its standard file-read tool with the `SKILL.md` path from the catalog. No special infrastructure needed — the agent's existing file-reading capability is sufficient. The model receives the file content as a tool result. This is the simplest approach when the model has file access.

**Dedicated tool activation**: Register a tool (e.g., `activate_skill`) that takes a skill name and returns the content. This is required when the model can't read files directly, and optional (but useful) even when it can. Advantages over raw file reads:

* Control what content is returned — e.g., strip YAML frontmatter or preserve it (see [What the model receives](#what-the-model-receives) below)
* Wrap content in structured tags for identification during context management
* List bundled resources (e.g., `references/*`) alongside the instructions
* Enforce permissions or prompt for user consent
* Track activation for analytics

<Tip>
  If you use a dedicated activation tool, constrain the `name` parameter to the set of valid skill names (e.g., as an enum in the tool schema). This prevents the model from hallucinating nonexistent skill names. If no skills are available, don't register the tool at all.
</Tip>

### User-explicit activation

Users should also be able to activate skills directly, without waiting for the model to decide. The most common pattern is a **slash command or mention syntax** (`/skill-name` or `$skill-name`) that the harness intercepts. The specific syntax is up to you — the key idea is that the harness handles the lookup and injection, so the model receives skill content without needing to take an activation action itself.

An autocomplete widget (listing available skills as the user types) can also make this discoverable.

### What the model receives

When a skill is activated, the model receives the skill's instructions. Two options for what exactly that content looks like:

**Full file**: The model sees the entire `SKILL.md` including YAML frontmatter. This is the natural outcome with file-read activation, where the model reads the raw file. It's also a valid choice for dedicated tools. The frontmatter may contain fields useful at activation time — for example, [`compatibility`](/specification#compatibility-field) notes environment requirements that could inform how the model executes the skill's instructions.

**Body only (frontmatter stripped)**: The harness parses and removes the YAML frontmatter, returning only the markdown instructions. Among existing implementations with dedicated activation tools, most take this approach — stripping the frontmatter after extracting `name` and `description` during discovery.

Both approaches work in practice.

### Structured wrapping

If you use a dedicated activation tool, consider wrapping skill content in identifying tags. For example:

```xml  theme={null}
<skill_content name="pdf-processing">
# PDF Processing

## When to use this skill
Use this skill when the user needs to work with PDF files...

[rest of SKILL.md body]

Skill directory: /home/user/.agents/skills/pdf-processing
Relative paths in this skill are relative to the skill directory.

<skill_resources>
  <file>scripts/extract.py</file>
  <file>scripts/merge.py</file>
  <file>references/pdf-spec-summary.md</file>
</skill_resources>
</skill_content>
```

This has practical benefits:

* The model can clearly distinguish skill instructions from other conversation content
* The harness can identify skill content during context compaction ([Step 5](#step-5-manage-skill-context-over-time))
* Bundled resources are surfaced to the model without being eagerly loaded

### Listing bundled resources

When a dedicated activation tool returns skill content, it can also enumerate supporting files (scripts, references, assets) in the skill directory — but it should **not eagerly read them**. The model loads specific files on demand using its file-read tools when the skill's instructions reference them.

For large skill directories, consider capping the listing and noting that it may be incomplete.

### Permission allowlisting

If your agent has a permission system that gates file access, **allowlist skill directories** so the model can read bundled resources without triggering user confirmation prompts. Without this, every reference to a bundled script or reference file results in a permission dialog, breaking the flow for skills that include resources beyond the `SKILL.md` itself.

## Step 5: Manage skill context over time

Once skill instructions are in the conversation context, keep them effective for the duration of the session.

### Protect skill content from context compaction

If your agent truncates or summarizes older messages when the context window fills up, **exempt skill content from pruning**. Skill instructions are durable behavioral guidance — losing them mid-conversation silently degrades the agent's performance without any visible error. The model continues operating but without the specialized instructions the skill provided.

Common approaches:

* Flag skill tool outputs as protected so the pruning algorithm skips them
* Use the [structured tags](#structured-wrapping) from Step 4 to identify skill content and preserve it during compaction

### Deduplicate activations

Consider tracking which skills have been activated in the current session. If the model (or user) attempts to load a skill that's already in context, you can skip the re-injection to avoid the same instructions appearing multiple times in the conversation.

### Subagent delegation (optional)

This is an advanced pattern only supported by some clients. Instead of injecting skill instructions into the main conversation, the skill is run in a **separate subagent session**. The subagent receives the skill instructions, performs the task, and returns a summary of its work to the main conversation.

This pattern is useful when a skill's workflow is complex enough to benefit from a dedicated, focused session.


Built with [Mintlify](https://mintlify.com).