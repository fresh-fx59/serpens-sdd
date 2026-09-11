# Planted fixture for the CI-vendor-DSL gate

This block exists to be caught, not to ship.

```groovy
stage('docs-disposer') { steps { sh '<serpens-sdd> verify-docs' } }
```
