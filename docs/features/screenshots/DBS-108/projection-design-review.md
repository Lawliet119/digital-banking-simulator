**APPROVE**, subject to implementing the validation in the order described.

The proposed bounds match the contract: doubled medians range from `2` through `18446744073709551614`, and BigInt quotient/remainder preserves integer and half-unit medians without floating-point loss. For example, the upper bound projects to `9223372036854775807`; one less projects to `9223372036854775806.5`. Both pass the existing `projectFeatures` checks.

Check that the input is a string and enforce the 20-character limit **before** calling `BigInt`. Retaining the generic error and existing allowlist projection avoids introducing a new error-disclosure or payload-privacy risk.