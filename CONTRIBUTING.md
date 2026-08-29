# Contributing to Delego

Thank you for your interest in contributing to Delego! We welcome contributions from everyone and are excited to have you join our community.

## 📋 Table of Contents

- [Getting Started](#getting-started)
- [Database Migrations](#database-migrations)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Project Areas](#project-areas)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Security](#security)
- [Community Guidelines](#community-guidelines)

## 🚀 Getting Started

### Prerequisites

Before you begin contributing, ensure you have the following installed:

- **Node.js** >= 20.0.0
- **pnpm** >= 9.0.0
- **Docker** >= 24.0.0
- **Git** (for version control)

### Setup Instructions

1. **Fork the Repository**
   ```bash
   # Fork the repository on GitHub
   # Then clone your fork
   git clone https://github.com/YOUR_USERNAME/delego-backend.git
   cd delego-backend
   ```

2. **Install Dependencies**
   ```bash
   pnpm install
   ```

3. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your local configuration
   ```

4. **Start Infrastructure**
   ```bash
   pnpm docker:up
   ```

5. **Run Database Migrations**
   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

6. **Start Development Server**
   ```bash
   pnpm dev
   ```

For detailed setup instructions, see [docs/contributor-guide.md](./docs/contributor-guide.md).

## 🗄️ Database Migrations

Schema changes are managed by the deterministic migration runner in `scripts/setup/migrate.js`. See [database/migrations/README.md](./database/migrations/README.md) for full details.

- `database/schema/` is the immutable baseline applied to a new database; `database/migrations/` holds incremental changes.
- Files run in numeric-prefix order, then filename. Every file is tracked by filename and SHA-256 checksum in `schema_migrations`.
- Applied migrations are skipped on reruns (a second `pnpm db:migrate` is a no-op).
- **Never edit an applied migration file.** Checksum drift fails every subsequent migration run — create a new migration instead.

### Fresh database setup

```bash
docker compose down -v
docker compose up -d --wait postgres
pnpm db:migrate
pnpm db:migrate:status
```

A clean environment must contain all expected tables before services start.

### Checking migration status

```bash
pnpm db:migrate:status
```

Lists applied and pending migrations plus checksum-drift errors, and exits non-zero when metadata is inconsistent.

### Running migration tests

```bash
docker compose up -d --wait postgres
pnpm test:integration
```

The integration suite covers fresh setup, no-op reruns, status output, checksum drift, duplicate versions, and deterministic ordering against disposable databases. Tests are skipped automatically when no PostgreSQL is reachable.

### Before opening a PR

```bash
find database/migrations -maxdepth 1 -type f -name '*.sql' \
  | sed -E 's#.*/([0-9]+)_.*#\1#' | sort | uniq -d
```

This must print nothing — duplicate version numbers fail CI. Also verify a clean Docker environment migrates end-to-end (`docker compose down -v && docker compose up -d --wait postgres && pnpm db:migrate`) and that `git diff` does not modify existing migration files.

## 🔄 Development Workflow

### 1. Choose an Issue

- Browse [GitHub Issues](https://github.com/DelegoLabs/Delego-backend/issues) for open issues
- Look for issues labeled `good first issue` if you're new to the project
- Comment on the issue to claim it and ask questions if needed
- Create a new issue if you've found a bug or have a feature request

### 2. Create a Branch

```bash
# Ensure your main branch is up to date
git checkout main
git pull upstream main

# Create a feature branch
git checkout -b feat/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

**Branch Naming Convention:**
- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions or changes
- `chore/` - Maintenance tasks

### 3. Make Your Changes

- Write clear, focused commits
- Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification
- Add tests for new functionality
- Update documentation as needed

**Commit Message Format:**
```
type(scope): subject

body

footer
```

Examples:
```
feat(gateway): add JWT authentication middleware

Implement JWT-based authentication for the API gateway.
Includes token generation, validation, and refresh logic.

Closes #123
```

```
fix(agents): resolve memory leak in agent runtime

Fixed memory leak caused by unclosed agent sessions.
Added proper cleanup in the agent shutdown process.

Fixes #456
```

### 4. Test Your Changes

```bash
# Run type checking
pnpm typecheck

# Run linting
pnpm lint

# Run tests
pnpm test

# Run specific test suites
pnpm test:unit
pnpm test:integration
```

### 5. Submit a Pull Request

- Push your branch to your fork
- Open a pull request against the `main` branch
- Use the PR template and provide a detailed description
- Link related issues
- Request review from maintainers

## 📐 Code Standards

### TypeScript

- **Strict Mode**: All TypeScript projects use strict mode
- **No `any`**: Avoid using `any` type without justification
- **Type Safety**: Leverage TypeScript's type system fully
- **Interfaces**: Use interfaces for object shapes
- **Enums**: Use enums for fixed sets of values
- **Null Checks**: Enable strict null checks
- **Naming**: Use camelCase for variables, PascalCase for types/classes

```typescript
// Good
interface User {
  id: string;
  name: string;
  email: string;
}

function getUserById(id: string): Promise<User | null> {
  // Implementation
}

// Bad
function getUserById(id: any): any {
  // Implementation
}
```

### Rust (Soroban Contracts)

Rust/Soroban contracts are developed in the separate [DelegoLabs/Delego-contracts](https://github.com/DelegoLabs/Delego-contracts) repository. See its contributing guide for Rust-specific conventions.

### General Guidelines

- **TODO Comments**: Mark incomplete logic with `// TODO:` and link to an issue when possible
- **Code Comments**: Add comments for complex logic, not obvious code
- **Function Length**: Keep functions focused and reasonably short
- **File Organization**: Group related functionality together
- **Imports**: Organize imports logically (stdlib, external, internal)

## 🎯 Project Areas

### API Gateway (`apps/backend/gateway`)

**Tech Stack:** Node.js, TypeScript

**Good First Issues:**
- API endpoint implementation
- Authentication middleware
- Rate limiting improvements
- Request validation
- Error handling

**Key Files:**
- `routes/` - API route definitions
- `auth/` - Authentication logic

### Orchestrator Service (`apps/backend/orchestrator`)

**Tech Stack:** Node.js, TypeScript, custom state machine (via `@delegolabs/utils`)

**Good First Issues:**
- Workflow state definitions
- Event handling
- Service orchestration
- State machine transitions

**Key Files:**
- `workflows/` - Workflow definitions
- `state/` - State machine logic
- `execution/` - Workflow execution

### Agents Service (`agents`)

**Tech Stack:** Node.js, TypeScript, LLM APIs

**Good First Issues:**
- Agent prompt engineering
- Tool implementation
- Memory management
- Response parsing

**Key Files:**
- `buyer-agent/` - Buyer agent implementation
- `payment-agent/` - Payment agent implementation
- `src/` - Agent runtime (LLM and tool integration)

### Wallet Service (`apps/backend/wallet`)

**Tech Stack:** Node.js, TypeScript, Stellar SDK

**Good First Issues:**
- Stellar account management
- Soroban permission grants
- Transaction signing
- Balance tracking

**Key Files:**
- `stellar/` - Stellar integration
- `soroban/` - Soroban contract interaction
- `keys/` - Key management

### Payments Service (`apps/backend/payments`)

**Tech Stack:** Node.js, TypeScript, Soroban SDK

**Good First Issues:**
- Escrow coordination
- Payment event processing
- Settlement logic
- Refund handling

**Key Files:**
- `escrow/` - Escrow contract coordination
- `settlement/` - Settlement logic
- `events/` - Payment event handling

### Shared Packages (`packages/`)

**Tech Stack:** TypeScript

**Good First Issues:**
- Type definitions
- Utility functions
- SDK methods

**Key Files:**
- `types/src/` - Shared TypeScript types
- `utils/src/` - Utility functions
- `sdk/src/` - API client SDK
- `cache/src/` - Redis Cluster client config, cache-aside helpers, tag-based invalidation

## 🧪 Testing Guidelines

### Test Coverage

- Aim for high test coverage on critical paths
- Write unit tests for individual functions
- Write integration tests for service interactions
- Write contract tests for smart contracts
- Write E2E tests for critical user flows

### Test Structure

```typescript
// Unit test example
describe('UserService', () => {
  describe('createUser', () => {
    it('should create a new user with valid data', async () => {
      const user = await userService.createUser({
        name: 'Test User',
        email: 'test@example.com',
      });
      
      expect(user).toBeDefined();
      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');
    });

    it('should throw error for duplicate email', async () => {
      await expect(
        userService.createUser({
          name: 'Test User',
          email: 'existing@example.com',
        })
      ).rejects.toThrow('Email already exists');
    });
  });
});
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests only
pnpm test:integration

# Run a specific service's tests in watch mode
pnpm --filter @delegolabs/gateway exec vitest
```

## 📚 Documentation

### When to Update Documentation

- Adding new features or services
- Changing existing APIs
- Modifying architecture
- Updating configuration
- Adding new commands or scripts

### Documentation Files

- **README.md**: Project overview and quick start
- **ARCHITECTURE.md**: System architecture details
- **CONTRIBUTING.md**: Contribution guidelines (this file)
- **docs/**: Detailed documentation
  - `docs/architecture/`: Technical architecture
  - `docs/api-reference.md`: API documentation
  - `docs/contributor-guide.md`: Contributor guide

### Documentation Style

- Use clear, concise language
- Include code examples
- Provide step-by-step instructions
- Use proper formatting (headings, lists, code blocks)
- Keep documentation up to date with code changes

## 🔀 Pull Request Process

### Before Submitting

1. **Code Quality**
   - [ ] `pnpm typecheck` passes
   - [ ] `pnpm lint` passes
   - [ ] `pnpm test` passes
   - [ ] No console.log statements left in production code

2. **Testing**
   - [ ] Tests added for new functionality
   - [ ] All tests pass
   - [ ] Test coverage maintained or improved

3. **Documentation**
   - [ ] README updated if adding new service/package
   - [ ] API documentation updated if changing APIs
   - [ ] Comments added for complex logic

4. **Commit Messages**
   - [ ] Follows Conventional Commits specification
   - [ ] Clear and descriptive
   - [ ] Links to related issues

### Submitting the PR

1. **Title**: Use a clear, descriptive title following Conventional Commits
2. **Description**: Provide a detailed description of changes
3. **Related Issues**: Link to related issues using `Closes #123` or `Fixes #123`
4. **Screenshots**: Include screenshots for UI changes
5. **Checklist**: Complete the PR template checklist

### Review Process

- Maintainers will review your PR
- Address feedback in a timely manner
- Be open to suggestions and improvements
- Keep discussions focused and constructive

### After Merge

- Delete your feature branch
- Celebrate your contribution! 🎉

## 🐛 Reporting Issues

### Bug Reports

When reporting a bug, include:

1. **Clear Title**: Descriptive title for the issue
2. **Description**: Detailed description of the problem
3. **Reproduction Steps**: Steps to reproduce the issue
4. **Expected Behavior**: What you expected to happen
5. **Actual Behavior**: What actually happened
6. **Environment Details**:
   - OS: [e.g., macOS, Ubuntu, Windows]
   - Node version: [e.g., 20.0.0]
   - pnpm version: [e.g., 9.0.0]
   - Browser (if applicable): [e.g., Chrome 120]

**Example:**
```
Title: Wallet service fails to connect to Stellar testnet

Description:
The wallet service fails to connect when attempting to connect to Stellar testnet. The connection times out after 30 seconds.

Steps to Reproduce:
1. Start the wallet service
2. Attempt to connect to Stellar testnet
3. Observe timeout error

Expected Behavior:
Service should successfully connect to Stellar testnet

Actual Behavior:
Connection times out with error: "ETIMEDOUT"

Environment:
- OS: Ubuntu 22.04
- Node: 20.0.0
- pnpm: 9.0.0
```

### Feature Requests

When requesting a feature, include:

1. **Clear Title**: Descriptive title for the feature
2. **Description**: Detailed description of the feature
3. **Use Case**: Why this feature is needed
4. **Proposed Solution**: How you envision the feature working
5. **Alternatives**: Any alternative solutions considered
6. **Additional Context**: Any other relevant information

## 🔒 Security

### Reporting Security Vulnerabilities

**Do not** open public issues for security vulnerabilities.

To report a security vulnerability:

1. Email us at: security@delego.dev
2. Include details and reproduction steps
3. We will respond promptly and coordinate disclosure
4. We will work with you to fix the issue
5. We will coordinate the public disclosure timeline

### Security Best Practices

- Never commit secrets or API keys
- Use environment variables for sensitive configuration
- Review dependencies for known vulnerabilities
- Follow secure coding practices
- Test security-related functionality thoroughly

## 🤝 Community Guidelines

### Code of Conduct

Please read and follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

### Communication

- Be respectful and constructive in all communications
- Welcome newcomers and help them get started
- Focus on what is best for the community
- Show empathy towards other community members

### Getting Help

- Check existing documentation first
- Search GitHub Issues for similar problems
- Ask questions in GitHub Discussions
- Join our community chat (link coming soon)

### Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes
- Project documentation

## 📞 Contact

- **GitHub Issues**: For bugs and feature requests
- **GitHub Discussions**: For questions and general discussion
- **Security**: security@delego.dev (for security issues only)

## 🙏 Thank You

Thank you for contributing to Delego! Your contributions help make AI-powered delegated commerce more accessible and secure for everyone.

---

For more detailed information, see:
- [Contributor Guide](./docs/contributor-guide.md)
- [Architecture Documentation](./ARCHITECTURE.md)
- [API Reference](./docs/api-reference.md)
