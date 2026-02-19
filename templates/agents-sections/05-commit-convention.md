## Commit Convention

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

Trailers enable `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link tests to acceptance criteria using language-appropriate comment syntax:

```javascript
// AC: @spec-item ac-N
it('should validate input', () => { ... });
```

```python
# AC: @spec-item ac-N
def test_validates_input():
    ...
```

Every AC SHOULD have at least one test with this annotation.
