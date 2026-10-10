-- Globie Earth :: 248 :: correct the Bamboo Rhizome Sovereign Thai name
--
-- "ไผ่ตงศรีอีสาน" (Phai Tong Sri Isan) is not a recognised Thai bamboo variety.
-- The guard's species is pinned to Dendrocalamus asper, and ไผ่ตง (Phai Tong) is
-- the "sweet bamboo" of Thai agriculture; the recognised, most-cited commercial
-- name for it is ไผ่ตงศรีปราจีน (Sri-Prachin bamboo, the Prachin Buri economic
-- bamboo used throughout DOA research). So the fabricated "ศรีอีสาน" suffix is
-- corrected to "ศรีปราจีน" and the species stays as it was.
--
-- The rename is applied to the catalogue row and to the embedded passage text so
-- a search hit and the guardian page agree. The stored vector is left untouched:
-- the Thai name only appears inside `content`, so the change is semantically
-- neutral and a full re-embed is not required.
update api.guardians
   set thai_name = 'ไผ่ตงศรีปราจีน'
 where id = 'bamboo-sovereign';

update api.embeddings
   set content = replace(content, 'ไผ่ตงศรีอีสาน', 'ไผ่ตงศรีปราจีน')
 where entity_type = 'guardian'
   and entity_id = 'bamboo-sovereign';

notify pgrst, 'reload schema';
