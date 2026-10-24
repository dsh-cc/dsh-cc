---- MODULE Model ----
EXTENDS Naturals, TLC
VARIABLE x
Init == x = 2
Next == x' = x
TypeOK == x \in 0..1
Spec == Init /\ [][Next]_x

====
