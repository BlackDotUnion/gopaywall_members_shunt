var crypto    = require('crypto');
var querystring = require('querystring');
var request = require('request');
var csvParser = require('csv-parse');
var cheerio = require('cheerio');

var config = {
    user: process.env.GOPAYWALL_USER,
    password: process.env.GOPAYWALL_PASS,
    host: process.env.GOPAYWALL_HOST
};

var publicFields = [
  'first_name',
  'middle_name',
  'last_name',
  'professional_title',
  'description',
  'skills', // TODO: array elements need to be processed somewhow
  'interests',
  'twitter',
  'facebook',
  'instagram',
  'linkedin',
  'avatar',
  'websites',
];

function getUsersCsv(callback) {
    var loginData = {
        form: {
            username: config.user,
            password: config.password,
            submit: "",
            doLogin: 1
        },
        followRedirect: true,
        followAllRedirects: true,
        jar: true
    };

    request.post('https://gopaywall.com/login.php', loginData, function (error, response, body) {
        if (error) {
            callback(error);
            return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            callback(new Error("Login request failed with status: " +
            response.statusCode));
        }

        request.get('https://' + config.host + '.gopaywall.com/exportusers.php', {jar: true}, function (err, response, body) {
            if (err) {
                callback(err);
                return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                callback(new Error("CSV request failed with status: " + response.statusCode));
            }

            callback(null, body);
        });
    });
}

function getCustomFields(callback) {
    request.get('https://' + config.host + '.gopaywall.com/index.php?do=fields', {jar: true}, function (err, response, body) {
        if (err) {
            callback(err);
            return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            callback(new Error("custom fields request failed with status: " + response.statusCode));
        }

        var $ = cheerio.load(body);

        var fields = [];
        $('.content table tr').each(function () {
            fields.push($('td', this).eq(1).text());
        });

        callback(null, fields);
    });
}

function parseData(csvRows, customFields, callback) {
    var rows = [];

    var columnIndices = {};
    for (var i = 0; i != csvRows[0].length; ++i) {
        columnIndices[csvRows[0][i]] = i;
    }

    for (var j = 1; j != csvRows.length; ++j) {
        var row = {};
        for (var name in columnIndices) {
            var columnIndex = columnIndices[name],
                columnValue = csvRows[j][columnIndex];

            if (name == 'custom_fields') {
                var parts = columnValue.split('::');

                var customFieldsObj = {};
                customFields.forEach(function (fieldName, fieldIndex) {
                    customFieldsObj[fieldName] = parts[fieldIndex] || '';
                });
                row[name] = customFieldsObj;
            } else {
                row[name] = columnValue;
            }
        }

        rows.push(row);
    }

    callback(null, rows);
}

function isUserAuthenticated(user, authKey, parsedData) {
    var userInfo = parsedData.find(function (row) {
        if (row.username == user) {
            return true;
        }
    });

    if (!userInfo) {
        return false;
    }

    var minute = (new Date()).getMinute();
    for (var minuteDiff = -1; minuteDiff != 2; ++minuteDiff) {
        var expectedAuthKey = makeAuthKey(userInfo, minuteDiff + minute);
        if (expectedAuthKey == authKey) {
            return true;
        }
    }

    return false;
}

function makeAuthKey(userInfo, minute) {
    var body = [userInfo.email, userInfo.fname + " " + userInfo.lname, userInfo.id, userInfo.membership_id].join(':');

    var hmac = crypto.createHmac('sha1', userInfo.last_login + minute);
    hmac.setEncoding('hex');
    hmac.write(body);
    hmac.end();
    return hmac.read();
}

function * getUsersData(user, auth_key) {
    var csvDataStr = yield getUsersCsv;
    var parsedCsv = yield csvParser.bind(null, csvDataStr);
    var customFields = yield getCustomFields;
    var parsedData = yield parseData.bind(null, parsedCsv, customFields);
    if (!isUserAuthenticated(user, auth_key, parsedData)) {
        parsedData = parsedData.map(function (row) {
          var newRow = {};
          Object.keys(row).forEach(function (columnName) {
            if (publicFields.indexOf(columnName) !== -1) {
              newRow[columnName] = row[columnName];
            }
          });
          return newRow;
        });
    }
    return parsedData;
}

var koa = require('koa');
var app = koa();

app.use(function *(){
    var user = this.request.query.user,
        auth_key = this.request.query.auth_key,
        test = this.request.query.test;

    this.set("Content-Type", "application/json");

    var result;
    if (test) {
        this.set("Access-Control-Allow-Origin", "*");
        result = require('./test_data.json');
    } else {
        this.set("Access-Control-Allow-Origin", "*");
        result = yield getUsersData(user, auth_key);
    }

    this.body = JSON.stringify(result);
});

app.listen(process.env.PORT);

console.log("listening...");
