import Mathlib.Core

theorem p1_proof : ∀ (a b : Nat), a + b = b + a := fun a b => Nat.add_comm a b
