## Commit Convention

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

Trailers enable `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link tests to acceptance criteria:

```typescript
// AC: @spec-item ac-N
it('should validate input', () => { ... });
```

Every AC SHOULD have at least one test with this annotation.
