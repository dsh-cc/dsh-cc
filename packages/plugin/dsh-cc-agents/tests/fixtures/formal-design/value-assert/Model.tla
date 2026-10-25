---- MODULE Model ----
EXTENDS Naturals, TLC
VARIABLE x
Init == x = 0
Next == x' = IF Assert(FALSE, "fixture") THEN 1 ELSE 0
TypeOK == x \in 0..1
Spec == Init /\ [][Next]_x

====
