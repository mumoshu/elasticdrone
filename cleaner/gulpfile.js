var gulp = require("gulp");

gulp.task("default", function () {
    return gulp.src("src/app.js")
        .pipe(babel())
        .pipe(gulp.dest("dist"));
});

var path = require("path");
var webpack = require('gulp-webpack');
var wp = require('webpack');
var nodeExternals = require('webpack-node-externals');

function buildJs (options, callback) {
    var plugins = options.minify ? [
        new wp.optimize.UglifyJsPlugin({
            compress: {
                warnings: false,
            },

            output: {
                comments: false,
                semicolons: true,
            }
        }),
    ] : [];

    var webpackConfig = {
        //entry: path.join(__dirname, "src", "index.js"),
        //entry: './src/index.js',
        entry: options.entry,
        bail: !options.watch,
        watch: options.watch,
        devtool: "source-map",
        plugins: plugins,
        //output: {
        //    //path: path.join(__dirname, "dist"),
        //    filename: "./dist/[name].js"
        //},
        output: {
            //filename: 'dist/[name]/[name]-[hash].js',
            filename: 'dist/[name].js'
            //filename: 'dist/index.js'
        },
        debug: true,
        module: {
            loaders: [
                {
                    loader: "babel-loader",
                    test: /\.js/,
                    include: options.include,
                    exclude: options.exclude,
                    query: {
                        presets: ['es2015']
                    }
                },
                // @see https://github.com/aws/aws-sdk-js/issues/603#issuecomment-125335891
                {
                    loader: 'json-loader',
                    test: /\.json/
                }
            ],
            // @see https://github.com/aws/aws-sdk-js/issues/603
            noParse: [
                /aws-sdk/,
            ]
        },
        // @see https://github.com/webpack/jade-loader/issues/8#issuecomment-55568520
        node: {
            fs: 'empty',
            net: 'empty',
            dns: 'empty'
        },
        // @see https://github.com/webpack/webpack/issues/839
        target: 'node',
        externals: nodeExternals()
    };

    return gulp.src('')
        .pipe(webpack(webpackConfig))
        .pipe(gulp.dest(''));
}

gulp.task("js:es6", function (callback) {
    return buildJs({ watch: false, minify: false }, callback);
});

gulp.task("sidenote:build", function (callback) {
    return buildJs({
            watch: false,
            minify: true,
            entry: {
                sidenote: './src/sidenote.js'
            },
            include: [
                path.resolve(__dirname, 'src/')
            ]
    }
        , callback);
});

gulp.task("watch", function () {
    return buildJs({ watch: true, minify: false });
});

gulp.task("manager:build", function (callback) {
    return buildJs({
        watch: false,
        minify: true,
        entry: {
            cleanup: './src/cleanup.js'
        },
        include: [
            path.resolve(__dirname, 'src/')
        ]
    }, callback);
});
