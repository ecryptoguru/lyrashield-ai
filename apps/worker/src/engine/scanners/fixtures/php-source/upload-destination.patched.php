<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$destination = '/srv/quarantine/' . bin2hex(random_bytes(16));
move_uploaded_file($_FILES['document']['tmp_name'], $destination);
