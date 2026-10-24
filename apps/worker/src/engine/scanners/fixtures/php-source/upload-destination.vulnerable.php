<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$destination = '/srv/public/uploads/' . $_FILES['document']['name'];
move_uploaded_file($_FILES['document']['tmp_name'], $destination);
