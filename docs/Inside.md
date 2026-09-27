What's Inside
Services (apps/backend/)
Service	Package	Port	Responsibility
Gateway	@delegolabs/gateway	3000	Single API entry point: auth (JWT), RBAC, rate limiting, routing
Orchestrator	@delegolabs/orchestrator	3010	Purchase workflow coordination and state machine
Wallet	@delegolabs/wallet	3012	Stellar accounts, Soroban permissions, tx signing/submission
Payments	@delegolabs/payments	3014	Escrow coordination, settlements, refunds
Notifications	@delegolabs/notifications	3015	Email/push notifications with retry (DLQ)
Cert Manager	@delegolabs/certmanager	3020	Automated TLS certificates: ACME issuance, renewal, CT logs, inventory, revocation, deployment
Each service is independently deployable and exposes GET /health.
