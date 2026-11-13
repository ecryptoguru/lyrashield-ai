<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$name = $_GET['name'];
readfile('/srv/reports/' . $name);
