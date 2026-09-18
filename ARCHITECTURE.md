
# SIH 26189 Architecture

## 1. User flow

Investigator
 -> Dashboard
 -> Case
 -> Network Explorer
 -> Entity
 -> Relationship
 -> Source evidence
 -> Alert explanation

## 2. Data flow

FIR / CDR / transaction / report
 -> ingestion
 -> parsing
 -> NLP entity extraction
 -> relationship extraction
 -> entity resolution
 -> graph construction
 -> graph analytics
 -> anomaly detection
 -> API
 -> React visualization

## 3. Storage responsibility

PostgreSQL:
- users
- cases
- documents
- evidence metadata
- alerts
- audit logs
- processing jobs

Neo4j:
- Person
- Phone
- Vehicle
- Location
- Organization
- BankAccount
- Case
- Event
- relationships between entities

Object/file storage:
- original documents
- extracted text
- derived artifacts

## 4. AI modules

MVP:
- rule/mock extraction so the whole demo works

Next:
- NER: spaCy / transformer model
- relation extraction: transformer/rule hybrid
- entity resolution: deterministic matching + embeddings
- anomaly detection: Isolation Forest
- graph analytics: Neo4j GDS / NetworkX

## 5. Security

- JWT authentication
- RBAC
- password hashing
- HTTPS in deployment
- audit logging
- least-privilege database accounts
- evidence SHA-256 integrity hashes
- synthetic data for development/demo

## 6. Design principle

AI assists an investigator. It must not automatically label a person as guilty.
Every alert should expose:
- score
- reason
- supporting relationships
- source/evidence references
- confidence
