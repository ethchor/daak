# Daak

> Mail, on your terms.

Daak is an open, local-first, programmable email client built for humans and
agents.

Your mail. Your data. Your rules.

---

## 1. Brand

### Name

**Daak**

#### Origin

"Daak" (डाक) is an Indian word historically associated with mail, postal
communication, and the system through which letters and messages are delivered.

The name is intentionally simple. Daak takes something familiar and gives it a
new meaning for modern computing:

> Email should be something you own, not something you merely access.

#### Pronunciation

**Daak** — /daːk/

One syllable. Easy to pronounce globally.

#### Brand principle

**Indian at its root. Global in its execution.**

Daak should feel like a modern technology product first, with its Indian origin
becoming an interesting layer of identity rather than a visual theme.

---

## 2. Product definition

### One-line description

> Daak is an open, local-first, programmable email client.

### Short description

> Daak is a fast, privacy-first email client that keeps your data local, works
> offline, connects to open protocols, and lets you automate your mailbox with
> commands, rules, plugins, and AI.

### Long description

Daak rethinks email as a programmable system rather than a collection of
messages in a remote inbox.

Your mailbox contains conversations, people, files, decisions, tasks, and
actions. Daak brings these pieces together through a local-first architecture
built around open protocols, deterministic synchronization, commands,
automation, extensibility, and user-controlled intelligence.

It is designed to work with humans first and agents second — without giving up
control of your data.

Daak is open source, self-hostable, provider-independent, and designed to evolve
with the ecosystem around it.

---

## 3. Positioning

| Axis | Statement |
|---|---|
| Primary | **The programmable email client.** |
| Technical | **An open, local-first runtime for programmable email.** |
| Privacy | **Your mailbox belongs to you.** |
| Open source | **Open protocols. Open source. Your infrastructure.** |
| AI | **Bring your own intelligence.** |

---

## 4. Core tagline

> **Mail, on your terms.**

This is the primary brand tagline. It communicates ownership, privacy, control,
self-hosting, customization, and independence from providers.

It does not lock Daak into today's definition of email.

---

## 5. Supporting taglines

| Context | Line |
|---|---|
| Product | Email, rebuilt. |
| Developer | Mail, made programmable. |
| Privacy | Your mailbox belongs to you. |
| Open source | Open protocols. Open source. Your infrastructure. |
| AI | Bring your own intelligence. |
| Automation | Your inbox. Your rules. |
| Self-hosting | Run your mail your way. |
| Philosophy | Own the data. Control the system. |

---

## 6. The big idea

### Email isn't an inbox

Most email clients reduce email to:

```text
Inbox
  ↓
Message
  ↓
Reply
  ↓
Archive
```

Daak treats email as a connected system:

```text
                         DAAK
                           │
              ┌────────────┴────────────┐
              │                         │
           Messages                 Commands
              │                         │
        ┌─────┼─────┐           ┌───────┼───────┐
        │     │     │           │       │       │
     Threads Files People      Rules     AI    Agents
        │                       │       │       │
        └──────────┬────────────┴───────┴───────┘
                   │
               Providers
            JMAP / IMAP / ...
```

Daak turns the mailbox into a programmable environment.

---

## 7. Brand philosophy

Five principles.

### 01 — Ownership

Your email is your data. Daak should never make users feel like their mailbox
belongs to the application.

### 02 — Openness

Open protocols should win over proprietary ecosystems. Daak is designed around
standards and replaceable providers.

### 03 — Local-first

The network should enhance the experience, not define it. The client should
remain useful when the network disappears.

### 04 — Programmability

Every meaningful action should be expressible as a command. Email should be
something you can automate, extend, and integrate.

### 05 — User-controlled intelligence

AI should be a layer, not a dependency. Users choose:

- which model
- where it runs
- which data it sees
- what it is allowed to do

---

## 8. Target users

**Primary — developers.** People who care about open source, self-hosting,
keyboard-driven workflows, automation, APIs, privacy, and extensibility.

**Secondary — power users.** People who have outgrown conventional email clients
and want fast search, keyboard navigation, automation, offline access,
customization, and AI assistance.

**Third — privacy-conscious users.** People who want greater control over where
their email is stored, what services process it, which AI models see their data,
and how their mailbox is automated.

**Fourth — AI / agent users.** People who want their mailbox to become an
interface that agents can safely interact with.

---

## 9. What Daak is NOT

Daak is not:

- another Gmail clone
- an AI wrapper around an email API
- a closed SaaS mailbox
- a provider-specific client
- an automation service that requires access to all your mail
- a UI-only email application

Daak is infrastructure + client + programmable interface.

---

## 10. Product pillars

**Own** — Local-first storage. Offline operation. Self-hosting. No unnecessary
dependency on a central Daak service.

**Connect** — JMAP-native. Provider abstraction. Future IMAP support. Plugins
and integrations.

**Command** — Everything important becomes a command. Archive. Reply. Label.
Snooze. Move. Search. Automate.

**Understand** — Local search. Threading. AI annotations. Triage. Summaries.
User-controlled intelligence.

**Extend** — Plugins. Rules. Integrations. MCP. Agent interfaces.

---

## 11. Differentiation

Traditional email:

```text
Provider
   ↓
Remote mailbox
   ↓
Email client
   ↓
User
```

Daak:

```text
Provider
   ↓
Sync Engine
   ↓
Local Mail System
   ├── Search
   ├── Threads
   ├── Commands
   ├── Rules
   ├── AI
   ├── Plugins
   └── Agents
        ↓
      User
```

Daak doesn't merely display your mailbox. It gives you a programmable layer over
it.

---

## 12. The command registry

The command system is one of Daak's defining architectural concepts. Every user
action is represented as a command.

```text
Command
├── id
├── handler
├── metadata
├── keybinding
└── permissions
```

The same command can be invoked by keyboard shortcuts, the command palette, the
UI, automation rules, plugins, AI, and agents.

This creates one universal action layer.

**Marketing language:** If you can do it in Daak, you can command it.

---

## 13. AI

AI should never be the identity of Daak. Instead:

> Intelligence is a layer.

Daak supports user-controlled intelligence through a provider abstraction.
Potential providers: cloud AI APIs, local models, Ollama, self-hosted inference,
future on-device models.

**Initial features:** message summarization, triage, classification, extraction.

**Future:** drafting, semantic search, automated workflows, intelligent rules,
agent actions, contextual assistants.

**Core principle:** Your mail should never require our AI.

---

## 14. Agents

Daak is designed to make email accessible to software agents without making the
mailbox itself unsafe. The agent layer exposes controlled capabilities through
the command and annotation systems.

Potential capabilities: read messages, search, inspect threads, create
annotations, run commands, trigger rules, create drafts.

Future: calendar, tasks, CRM, documents, projects, external services.

**Positioning:** Your mailbox is an interface.

Or: Give agents access to your workflow, not unrestricted access to your data.

---

## 15. Open source

Daak is open source because your mailbox should not depend on a company's
permission to exist.

The project should be source available, self-hostable, standards-based,
community extensible, and transparent about data flows.

**Message:** Run it yourself. Read the code. Change it. Extend it.

---

## 16. Self-hosting

Daak should make self-hosting feel approachable rather than intimidating.

**Long-term goal:** `docker compose up` should be enough to get Daak + mail
server + database + storage running locally or on a server.

**Marketing:** Your server. Your mailbox. Your rules.

---

## 17. Visual identity

**Design direction:** Minimal. Technical. Warm. Quiet. Confident.

Avoid stereotypical "Indian tech" visual language. Do not rely on mandalas,
ornate patterns, excessive saffron, traditional decorative typography, or
literal postal imagery everywhere.

Instead, take inspiration from the idea of Daak: mail moving, messages
travelling, connections forming.

---

## 18. Logo concept

**Primary mark:** a minimal geometric D combined with a line representing the
movement of a message.

The line can subtly represent: Message → Thread → Command → Agent

The logo should work as a 16px favicon, as an application icon, in monochrome,
on dark backgrounds, on light backgrounds, and without the wordmark.

See `brand/daak-mark.svg`.

---

## 19. Visual motif

### The line

The primary visual motif is a continuous line. It represents communication,
movement, connection, synchronization, threads, commands, and events.

The line can occasionally split into nodes:

```text
────────●────────●───────
        │        │
        └──●─────┘
```

This becomes the visual language of Daak.

---

## 20. Color direction

**Base:** near-black, warm white, neutral gray.

**Accent:** a restrained deep vermilion/red.

The accent should represent the "Daak" identity without turning the entire
product into an Indian-themed interface.

**Principle:** Mostly monochrome. One memorable accent.

Implemented in `brand/tokens.css`.

---

## 21. Typography

Typography should feel modern and highly readable:

- clean sans-serif
- excellent UI legibility
- generous spacing
- strong hierarchy
- compact metadata
- monospace for technical surfaces

The wordmark should be custom or subtly modified rather than relying entirely on
a generic font treatment.

---

## 22. Voice

Daak should sound intelligent, calm, direct, technical when necessary, human,
and slightly opinionated.

Avoid startup buzzwords, excessive exclamation marks, "revolutionary",
"next-generation", "AI-powered everything", fake urgency, and corporate
language.

| Instead of | Say |
|---|---|
| The world's most revolutionary AI-powered email platform. | Email, rebuilt around ownership and control. |
| Seamlessly leverage cutting-edge AI. | Bring your own intelligence. |
| Supercharge your productivity. | Turn actions into commands. |

---

## 23. Brand vocabulary

**Prefer:** mail, mailbox, message, thread, command, rule, provider, local,
open, own, connect, automate, extend, intelligence, agent.

**Avoid:** inbox zero, productivity platform, AI-powered, ecosystem, synergy,
revolutionary, seamless, next-gen.

---

## 24. Website structure

**Hero**

> Mail, on your terms.
>
> Daak is an open, local-first, programmable email client built for humans and
> agents.
>
> [Get Daak] [GitHub]

**Your inbox is more than a list.** Email is conversations, people, files,
decisions, and actions. Daak brings them together into a system you can search,
control, automate, and extend.

**Own your mailbox.** Local-first storage. Offline by design. Self-hostable.
Open source. Your data shouldn't disappear because someone else's API changed.

**Make email programmable.** Every action in Daak is a command. Keyboard
shortcuts, command palette, automation, plugins, AI, and agents all speak the
same language.

**Bring your own intelligence.** Use cloud models. Use local models. Use your
own infrastructure. Choose what your mail is allowed to leave your machine for.

**Open by design.** JMAP-native. Provider-independent. Plugin-ready.
Agent-ready. Built around open interfaces rather than a closed ecosystem.

**Built for the long term.** Daak is designed so the mail provider, storage
layer, intelligence layer, and interface can evolve independently. The client
shouldn't become obsolete because one company changes its API.

---

## 25. Launch narrative

**Headline:** Email has been treated like an inbox for too long.

**Copy:**

Daak is an open, local-first, programmable email client.

It starts with a simple idea: your mail should belong to you.

Your data should be local. Your provider should be replaceable. Your workflows
should be programmable. Your AI should be yours to choose. And your mailbox
should be something software can work with — without giving up control.

Daak. Mail, on your terms.

---

## 26. Launch short description

Daak is a local-first, open-source email client built around programmable
commands, open protocols, offline-first storage, user-controlled AI, plugins,
and agent access.

---

## 27. GitHub description

Open, local-first, programmable email client for humans and agents.

---

## 28. Repository

`daak` — preferred. `daak-mail` as fallback.

---

## 29. Package naming

```text
@daak/contracts
@daak/mime
@daak/threading
@daak/store
@daak/sync
@daak/adapter-jmap
@daak/adapter-imap
@daak/search
@daak/intelligence
@daak/ui-core
@daak/plugin-host
@daak/web
```

---

## 30. Product architecture naming

Daak Core · Daak Sync · Daak Search · Daak Intelligence · Daak Commands ·
Daak Extensions · Daak Connect · Daak Agent

---

## 31. Possible future products

Daak Mail · Daak Calendar · Daak Tasks · Daak Contacts · Daak Agent ·
Daak Connect · Daak Server

The brand therefore represents a broader philosophy: personal communication
infrastructure you control.

---

## 32. Brand manifesto

We believe your mailbox is yours.

Not your provider's. Not an advertising company's. Not an AI company's. Yours.

We believe open protocols matter.

We believe local software should still work when the network doesn't.

We believe software should be programmable.

We believe AI should be a choice, not a requirement.

We believe extensions should extend a system without owning it.

We believe agents should interact through explicit capabilities, not
unrestricted access.

And we believe email can be better without becoming another closed platform.

So we're building Daak.

Open. Local. Programmable. Built for humans. Ready for what's next.

Daak — Mail, on your terms.

---

## 33. One-sentence brand definition

Daak is the open, local-first, programmable layer between you and your mail.

---

## 34. The brand in one screen

```text
                         DAAK
                 Mail, on your terms.
      Open · Local-first · Programmable · Extensible

                    ┌───────────┐
                    │   MAIL    │
                    └─────┬─────┘
                          │
             ┌────────────┼────────────┐
             │            │            │
          Threads      Commands      Search
             │            │            │
             └────────────┼────────────┘
                          │
                ┌─────────┴─────────┐
                │                   │
             Intelligence        Agents
                │                   │
                └─────────┬─────────┘
                          │
                     Providers
                 JMAP · IMAP · ...

             YOUR DATA. YOUR RULES.
```

Daak — Mail, on your terms.

Open source. Local-first. Programmable. Self-hostable. Built for humans and
agents.
