<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$page = $_GET['page'];
include '/srv/pages/' . $page . '.php';
