---- MODULE Model ----
EXTENDS Naturals, TLC
CONSTANT C
VARIABLE x
Init == x = 0
Next == x' = x
TypeOK == x \in 0..1
Spec == Init /\ [][Next]_x

====
